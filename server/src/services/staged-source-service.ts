import { and, asc, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  isStagedConnection,
  type EnvironmentDto,
  type StagedImportResultDto,
  type StagedSourceKind,
  type StagedPreviewDto,
  type StagedPreviewTableDto,
  type StagedTableDto,
} from '../../../shared/domain';
import type { AppDb } from '../db/client';
import { environmentAccess, environments, stagedRows, stagedTables, users } from '../db/schema';
import { inferTable, ROW_KEY, toTableMetadata, type InferredTable } from '../connectors/staged/infer-schema';
import {
  fetchDriveItem,
  fetchListRows,
  graphRequester,
  listDriveChildren,
  listSiteLists,
  listSites,
  resolveGraphTarget,
  resolveListReference,
  type GraphDriveItem,
  type GraphList,
  type GraphRequest,
  type GraphSite,
} from '../connectors/staged/graph';
import { stagedProvider } from '../connectors/staged/staged-connector';
import { readXlsx, type XlsxReadSheet } from '../lib/xlsx';
import { looksLikeXml, readXml, XmlReadError } from '../lib/xml';
import { badRequest, notFound } from '../lib/errors';
import { parseCsvRows } from './mapping-workbook-service';
import type { AuditService } from './audit-service';
import type { RequestContext } from './context';
import { toEnvironmentDto } from './environment-service';

/** A file this big is not a mapping of anything; it is an extract that belongs in a database. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ROWS_PER_TABLE = 500_000;
const MAX_COLUMNS = 300;
/** Rows are written in batches so one import is not one enormous statement. */
const INSERT_BATCH = 500;

/**
 * Importing a file, a spreadsheet or a list into a staged source.
 *
 * The import is where every difference between these sources lives: a CSV has one table, a workbook
 * has one per sheet, a list has its own shape. Once the rows are here they are all the same thing,
 * which is why the connector that reads them is one class and this is where the variety is handled.
 *
 * An import of the same table **replaces** it rather than appending. A file is a snapshot, and two
 * snapshots concatenated are not a bigger snapshot — they are a duplicate of everything that did not
 * change.
 */
/** The one thing this service needs from the metadata cache. */
export interface MetadataCache {
  forget(environmentId: string): Promise<void>;
}

export class StagedSourceService {
  constructor(
    private readonly db: AppDb,
    private readonly metadata: MetadataCache,
    private readonly audit: AuditService,
    private readonly logger: Logger,
    /** Issues a delegated Microsoft Graph token. Absent when the feature is switched off. */
    private readonly graphToken?: (userId: string) => Promise<string>,
  ) {}

  // ---------------------------------------------------------------------------
  // Creating the connection
  // ---------------------------------------------------------------------------

  /**
   * A staged connection needs no host, port or credential — only a name and what kind it is. So it
   * does not go through the SQL connection form at all.
   */
  async create(
    ctx: RequestContext,
    input: { displayName: string; kind: StagedSourceKind },
  ): Promise<EnvironmentDto> {
    const displayName = input.displayName.trim();
    if (!displayName) throw badRequest('A name is required');
    const kind = input.kind;
    const provider = stagedProvider(kind);
    // The url is the org-unique key for an environment, so it is derived from the name.
    const slug = displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
    const url = `${provider}://${slug || 'source'}`;

    const [existing] = await this.db
      .select({ id: environments.id })
      .from(environments)
      .where(and(eq(environments.organizationId, ctx.organizationId), eq(environments.url, url)));
    if (existing) throw badRequest(`A source called "${displayName}" already exists`);

    const [row] = await this.db
      .insert(environments)
      .values({
        organizationId: ctx.organizationId,
        provider,
        connectionType: kind === 'ONEDRIVE' ? 'ONEDRIVE' : kind === 'SHAREPOINT' ? 'SHAREPOINT' : 'FILE',
        displayName,
        url,
        uniqueName: slug,
        // Not a Dataverse environment and never a write target, so there is no environment class to
        // classify and nothing for the production-safety warning to act on.
        environmentType: null,
        dataverseAvailable: false,
        connectionStatus: 'CONNECTED',
        connectionMessage: 'Nothing imported yet',
      })
      .returning();
    await this.db.insert(environmentAccess).values({ environmentId: row.id, userId: ctx.userId });
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'CONNECTION_CREATED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: row.id,
      requestId: ctx.requestId,
      details: { displayName, kind },
    });
    this.logger.info({ environmentId: row.id, kind }, 'Staged source created');
    return toEnvironmentDto(row, false);
  }

  // ---------------------------------------------------------------------------
  // Importing
  // ---------------------------------------------------------------------------

  /**
   * Reads a CSV or a workbook into tables.
   *
   * A workbook becomes one table per sheet, because that is what a workbook is. A sheet with no
   * header row, or no rows beneath it, is skipped and reported — an empty tab is normal in a real
   * export and should not look like a failure.
   */
  async importFile(
    ctx: RequestContext,
    environmentId: string,
    file: { filename: string; content: Buffer },
    opts: { kind?: StagedSourceKind; sourceRef?: string; sheets?: string[] } = {},
  ): Promise<StagedImportResultDto> {
    const env = await this.stagedEnvironment(ctx, environmentId);
    if (file.content.length === 0) throw badRequest('That file is empty');
    if (file.content.length > MAX_FILE_BYTES) {
      throw badRequest(
        `That file is ${Math.round(file.content.length / 1024 / 1024)} MB; the limit is ${MAX_FILE_BYTES / 1024 / 1024} MB. Load an extract this size from a database connection instead.`,
      );
    }
    const kind = opts.kind ?? kindOf(env.connectionType);
    const sourceRef = (opts.sourceRef ?? file.filename).slice(0, 300);
    const sheets = readSheets(file.content, file.filename);

    /**
     * Which sheets the person actually asked for.
     *
     * A workbook that happens to contain "Instructions" and "Lookup Notes" tabs should not force two
     * meaningless datasets into an analysis, so the caller may name the sheets it wants. Omitting the
     * option takes the whole workbook, which is what every existing caller means.
     *
     * Matched on the reader's own sheet name. A selection that matches nothing is a mistake worth
     * naming rather than an import that silently does nothing.
     */
    const wanted = opts.sheets?.length ? new Set(opts.sheets) : null;
    if (wanted) {
      const available = sheets.map((s) => s.name);
      const unknown = [...wanted].filter((name) => !available.includes(name));
      if (unknown.length) {
        throw badRequest(
          `${file.filename} has no sheet called ${unknown.map((u) => `"${u}"`).join(', ')}. It has ${available.map((a) => `"${a}"`).join(', ')}.`,
        );
      }
    }

    const result: StagedImportResultDto = { tables: [], skipped: [], totalRows: 0, replaced: [] };
    for (const sheet of sheets) {
      // Not chosen is not the same as unusable, so an unselected sheet is not reported as skipped.
      if (wanted && !wanted.has(sheet.name)) continue;
      const prepared = prepareSheet(sheet);
      if (!prepared) {
        result.skipped.push({
          name: sheet.name,
          reason: 'no header row with values beneath it',
        });
        continue;
      }
      if (prepared.headers.length > MAX_COLUMNS) {
        result.skipped.push({
          name: sheet.name,
          reason: `${prepared.headers.length} columns; the limit is ${MAX_COLUMNS}`,
        });
        continue;
      }
      if (prepared.rows.length > MAX_ROWS_PER_TABLE) {
        result.skipped.push({
          name: sheet.name,
          reason: `${prepared.rows.length} rows; the limit is ${MAX_ROWS_PER_TABLE.toLocaleString()}`,
        });
        continue;
      }

      // The file names the table, not the sheet or the XML record element. The name is this
      // table's identity: importing over it replaces its rows. Element names collide across
      // exports — every monthly orders file holds <order> — so naming a table after one would make
      // two unrelated extracts overwrite each other. A file name is the thing that is already
      // distinct, and already means something to the person who uploaded it.
      const logicalName = tableNameFor(sheets.length > 1 ? sheet.name : file.filename, sheet.name);
      const existing = await this.existingTable(env.id, logicalName);
      if (existing) {
        result.replaced.push({
          logicalName,
          displayName: existing.displayName,
          previousRows: existing.rowCount,
          previousSourceRef: existing.sourceRef,
        });
      }
      const inferred = inferTable(
        logicalName,
        // A workbook sheet names its own table; a single-table file is named after the file, so
        // `orders.xml` does not become a table called "order".
        displayNameFor(sheets.length > 1 ? sheet.name : '', file.filename),
        prepared.headers,
        prepared.rows,
      );
      await this.store(
        ctx,
        env.id,
        kind,
        sourceRef,
        // Which part of the file the rows came from: a sheet, or the element that repeated.
        sheets.length > 1 ? sheet.name : (sheet.part ?? null),
        inferred,
        prepared,
      );
      result.tables.push(await this.tableDto(env.id, logicalName));
      result.totalRows += inferred.rowCount;
    }

    if (result.tables.length === 0) {
      throw badRequest(
        `Nothing in ${file.filename} could be read as a table. A sheet needs a header row with at least one row of values beneath it.`,
      );
    }
    // The shape of this source just changed. Anything cached about it describes the source as it
    // was a moment ago, which is worse than having nothing cached at all.
    await this.metadata.forget(env.id);
    await this.db
      .update(environments)
      .set({
        connectionStatus: 'CONNECTED',
        connectionMessage: `${result.tables.length} table(s), ${result.totalRows.toLocaleString()} row(s)`,
      })
      .where(eq(environments.id, env.id));
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'STAGED_SOURCE_IMPORTED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: env.id,
      requestId: ctx.requestId,
      details: {
        sourceRef,
        kind,
        tables: result.tables.map((t) => t.logicalName),
        rows: result.totalRows,
        skipped: result.skipped.length,
      },
    });
    this.logger.info(
      { environmentId: env.id, tables: result.tables.length, rows: result.totalRows },
      'Staged source imported',
    );
    return result;
  }

  /**
   * Imports a spreadsheet out of OneDrive or a SharePoint document library.
   *
   * The fetch is the only new part: once the bytes are here they go through exactly the same reader,
   * inference and storage a local upload does, so a file behaves the same however it arrived.
   */
  async importFromGraph(
    ctx: RequestContext,
    environmentId: string,
    input: { reference: string },
    request?: GraphRequest,
  ): Promise<StagedImportResultDto> {
    const env = await this.stagedEnvironment(ctx, environmentId);
    const graph = request ?? (await this.requester(ctx));
    const target = resolveGraphTarget(input.reference);
    const item = await fetchDriveItem(graph, target);
    this.logger.info(
      { environmentId: env.id, name: item.name, size: item.size },
      'Fetched a file from Microsoft Graph',
    );
    return this.importFile(
      ctx,
      environmentId,
      { filename: item.name, content: item.content },
      { kind: 'ONEDRIVE', sourceRef: target.sourceRef },
    );
  }

  /**
   * Imports a SharePoint list.
   *
   * The list's own column types are deliberately ignored in favour of inferring from the values: a
   * column declared Text routinely holds numbers and one declared Number routinely holds blanks, so
   * the values are the better evidence — and the reasoning is then reported the same way it is for a
   * spreadsheet.
   */

  /**
   * What is in this file, without committing to it.
   *
   * Uploading a file and discovering afterwards that the header row was wrong, or that the dates came
   * through as five-digit numbers, is how somebody ends up with a dataset they have to delete and
   * re-add. This runs the same reader and the same inference the import does, and returns what they
   * produced — **and stores nothing**. Nothing in the database changes until the user says to add it.
   *
   * The same code path as the import on purpose: a preview produced by a different parser would be a
   * preview of a different file.
   */
  async previewFile(
    ctx: RequestContext,
    file: { filename: string; content: Buffer },
  ): Promise<StagedPreviewDto> {
    if (file.content.length === 0) throw badRequest('That file is empty');
    if (file.content.length > MAX_FILE_BYTES) {
      throw badRequest(
        `That file is ${Math.round(file.content.length / 1024 / 1024)} MB; the limit is ${MAX_FILE_BYTES / 1024 / 1024} MB. Load an extract this size from a database connection instead.`,
      );
    }
    void ctx;
    const sheets = readSheets(file.content, file.filename);
    const tables: StagedPreviewTableDto[] = [];
    const skipped: { name: string; reason: string }[] = [];

    for (const sheet of sheets) {
      const prepared = prepareSheet(sheet);
      if (!prepared) {
        skipped.push({ name: sheet.name, reason: 'no header row with values beneath it' });
        continue;
      }
      const logicalName = tableNameFor(sheet.name, file.filename);
      const inferred = inferTable(logicalName, sheet.name || file.filename, prepared.headers, prepared.rows);
      tables.push({
        sheet: sheet.name,
        sheetName: sheets.length > 1 ? sheet.name : null,
        displayName: inferred.displayName,
        logicalName: inferred.logicalName,
        rowCount: inferred.rowCount,
        columnCount: inferred.columns.length,
        keyColumn: inferred.keyIsSynthetic ? null : inferred.keyColumn,
        columns: inferred.columns.map((c) => ({
          name: c.name,
          type: c.type,
          blanks: c.blanks,
          distinct: c.distinct,
          unique: c.unique,
          reason: c.reason,
          semantic: c.semantic,
        })),
        // Enough rows to recognise the data, few enough that nothing large reaches a browser.
        // Rendered the way the importer renders a cell, so the preview shows the value that will land.
        sampleRows: prepared.rows
          .slice(0, 10)
          .map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : String(cell)))),
      });
    }
    return { filename: file.filename, bytes: file.content.length, tables, skipped };
  }

  async importFromSharePointList(
    ctx: RequestContext,
    environmentId: string,
    input: { reference: string },
    request?: GraphRequest,
  ): Promise<StagedImportResultDto> {
    const env = await this.stagedEnvironment(ctx, environmentId);
    const graph = request ?? (await this.requester(ctx));
    const ref = resolveListReference(input.reference);
    const list = await fetchListRows(graph, ref, { maxRows: MAX_ROWS_PER_TABLE });
    if (list.rows.length === 0) {
      throw badRequest(`The list "${list.displayName}" has no items to import.`);
    }

    const logicalName = tableNameFor(list.displayName, ref.listId);
    const inferred = inferTable(logicalName, list.displayName, list.headers, list.rows);
    await this.store(ctx, env.id, 'SHAREPOINT', input.reference, null, inferred, {
      headers: list.headers,
      rows: list.rows,
    });
    const table = await this.tableDto(env.id, logicalName);
    await this.db
      .update(environments)
      .set({
        connectionStatus: 'CONNECTED',
        connectionMessage: `1 list, ${inferred.rowCount.toLocaleString()} item(s)`,
      })
      .where(eq(environments.id, env.id));
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'STAGED_SOURCE_IMPORTED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: env.id,
      requestId: ctx.requestId,
      details: { sourceRef: input.reference, kind: 'SHAREPOINT', rows: inferred.rowCount },
    });
    // A list import writes one table under a name taken from the list, and replaces it on a
    // re-import exactly as a file does.
    return { tables: [table], skipped: [], totalRows: inferred.rowCount, replaced: [] };
  }

  /** A Graph caller for the signed-in user, or a clear refusal when the feature is off. */
  // ---------------------------------------------------------------------------
  // Browsing: finding the content, rather than being told where it is
  // ---------------------------------------------------------------------------

  /**
   * Where a SharePoint connection could take its data from.
   *
   * Before this, importing needed `sites/{site-id}/lists/{list-id}` — a pair of ids that appear in no URL
   * anybody ever sees — so the only honest instruction the product could give was "ask a developer", and
   * a SharePoint connection that authenticated perfectly was a dead end.
   */
  async browseSites(ctx: RequestContext, environmentId: string, query?: string): Promise<GraphSite[]> {
    await this.stagedEnvironment(ctx, environmentId);
    return listSites(await this.requester(ctx), query);
  }

  /** The lists and document libraries of one site, without the plumbing ones. */
  async browseLists(ctx: RequestContext, environmentId: string, siteId: string): Promise<GraphList[]> {
    await this.stagedEnvironment(ctx, environmentId);
    return listSiteLists(await this.requester(ctx), siteId);
  }

  /**
   * One level of a drive: OneDrive's root, or a site's document library.
   *
   * One level rather than a recursive walk, because a document library can hold a hundred thousand items
   * and reading all of them to draw a folder nobody opened is slow and rude to somebody else's tenant.
   */
  async browseFiles(
    ctx: RequestContext,
    environmentId: string,
    opts: { siteId?: string; parentId?: string } = {},
  ): Promise<GraphDriveItem[]> {
    const env = await this.stagedEnvironment(ctx, environmentId);
    const drive = opts.siteId ? `sites/${opts.siteId}/drive` : 'me/drive';
    if (!opts.siteId && env.connectionType === 'SHAREPOINT') {
      throw badRequest('Choose a SharePoint site before browsing its files.');
    }
    return listDriveChildren(await this.requester(ctx), drive, opts.parentId ?? null);
  }

  private async requester(ctx: RequestContext): Promise<GraphRequest> {
    if (!this.graphToken) {
      throw badRequest(
        'Reading from OneDrive and SharePoint is switched off for this deployment. It needs MICROSOFT_FILES_ENABLED and a Microsoft sign-in, because the files are read with your own account.',
      );
    }
    return graphRequester(await this.graphToken(ctx.userId));
  }

  /** Writes one inferred table and its rows, replacing whatever was there before. */
  private async store(
    ctx: RequestContext,
    environmentId: string,
    kind: StagedSourceKind,
    sourceRef: string,
    sheetName: string | null,
    inferred: InferredTable,
    data: { headers: string[]; rows: (string | number | boolean | null)[][] },
  ): Promise<void> {
    const metadata = toTableMetadata(inferred);
    await this.db
      .delete(stagedRows)
      .where(
        and(eq(stagedRows.environmentId, environmentId), eq(stagedRows.logicalName, inferred.logicalName)),
      );

    const values = data.rows.map((row, i) => {
      const record: Record<string, unknown> = {};
      inferred.columns.forEach((column, c) => {
        const cell = row?.[c];
        record[column.name] = cell === undefined || cell === null || cell === '' ? null : cell;
      });
      const ordinal = i + 1;
      // A detected key identifies the row; otherwise the file's own position does, which is the only
      // identity a spreadsheet row has.
      const key = inferred.keyIsSynthetic ? String(ordinal) : String(record[inferred.keyColumn] ?? ordinal);
      if (inferred.keyIsSynthetic) record[ROW_KEY] = ordinal;
      return { environmentId, logicalName: inferred.logicalName, recordId: key, ordinal, data: record };
    });

    // A duplicate in a column that looked unique is possible in a file; the row is kept and
    // addressed by its position instead of being dropped.
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value.recordId)) value.recordId = `${value.recordId}#${value.ordinal}`;
      seen.add(value.recordId);
    }

    for (let i = 0; i < values.length; i += INSERT_BATCH) {
      await this.db.insert(stagedRows).values(values.slice(i, i + INSERT_BATCH));
    }
    await this.db
      .insert(stagedTables)
      .values({
        environmentId,
        logicalName: inferred.logicalName,
        displayName: inferred.displayName,
        kind,
        sourceRef,
        sheetName,
        rowCount: values.length,
        keyColumn: inferred.keyColumn,
        keyIsSynthetic: inferred.keyIsSynthetic,
        metadata,
        columns: inferred.columns.map((c) => ({
          name: c.name,
          type: c.type,
          maxLength: c.maxLength,
          blanks: c.blanks,
          distinct: c.distinct,
          unique: c.unique,
          reason: c.reason,
        })),
        importedByUserId: ctx.userId,
        importedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [stagedTables.environmentId, stagedTables.logicalName],
        set: {
          displayName: inferred.displayName,
          kind,
          sourceRef,
          sheetName,
          rowCount: values.length,
          keyColumn: inferred.keyColumn,
          keyIsSynthetic: inferred.keyIsSynthetic,
          metadata,
          columns: inferred.columns.map((c) => ({
            name: c.name,
            type: c.type,
            maxLength: c.maxLength,
            blanks: c.blanks,
            distinct: c.distinct,
            unique: c.unique,
            reason: c.reason,
          })),
          importedByUserId: ctx.userId,
          importedAt: new Date(),
        },
      });
  }

  // ---------------------------------------------------------------------------
  // Reading it back
  // ---------------------------------------------------------------------------

  async list(ctx: RequestContext, environmentId: string): Promise<StagedTableDto[]> {
    const env = await this.stagedEnvironment(ctx, environmentId);
    const rows = await this.db
      .select({ table: stagedTables, user: users.displayName })
      .from(stagedTables)
      .leftJoin(users, eq(users.id, stagedTables.importedByUserId))
      .where(eq(stagedTables.environmentId, env.id))
      .orderBy(asc(stagedTables.displayName));
    return rows.map((r) => toDto(r.table, r.user ?? null));
  }

  async removeTable(ctx: RequestContext, environmentId: string, logicalName: string): Promise<void> {
    const env = await this.stagedEnvironment(ctx, environmentId);
    const existing = await this.existingTable(env.id, logicalName);
    if (!existing) throw notFound('Dataset');
    await this.db
      .delete(stagedRows)
      .where(and(eq(stagedRows.environmentId, env.id), eq(stagedRows.logicalName, logicalName)));
    await this.db
      .delete(stagedTables)
      .where(and(eq(stagedTables.environmentId, env.id), eq(stagedTables.logicalName, logicalName)));
    await this.metadata.forget(env.id);
    /*
     * Recorded because removing data is exactly the kind of thing somebody asks about later. The rows go;
     * the analysis runs that profiled them do not, so an assessment produced before this remains readable
     * and this entry is what explains why its dataset is no longer listed.
     */
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'STAGED_SOURCE_TABLE_REMOVED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: env.id,
      requestId: ctx.requestId,
      details: { logicalName, displayName: existing.displayName, rows: existing.rowCount },
    });
    this.logger.info({ environmentId: env.id, logicalName }, 'Dataset removed');
  }

  /**
   * Renames a dataset, for a sheet somebody called "Sheet1" and a table called `TBL_CUST_MSTR_V2`.
   *
   * The display name only. `logicalName` is the identity an import replaces by and an analysis run refers
   * to, so renaming it would orphan both — a dataset is allowed to be called something better without
   * becoming a different dataset.
   */
  async renameTable(
    ctx: RequestContext,
    environmentId: string,
    logicalName: string,
    displayName: string,
  ): Promise<StagedTableDto> {
    const env = await this.stagedEnvironment(ctx, environmentId);
    const existing = await this.existingTable(env.id, logicalName);
    if (!existing) throw notFound('Dataset');
    const trimmed = displayName.trim();
    if (!trimmed) throw badRequest('A dataset needs a name');
    await this.db
      .update(stagedTables)
      .set({ displayName: trimmed })
      .where(and(eq(stagedTables.environmentId, env.id), eq(stagedTables.logicalName, logicalName)));
    await this.metadata.forget(env.id);
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'DATASET_RENAMED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: env.id,
      requestId: ctx.requestId,
      details: { logicalName, from: existing.displayName, to: trimmed },
    });
    return this.tableDto(env.id, logicalName);
  }

  /** What is already stored under this name, so an import can say what it is about to overwrite. */
  private async existingTable(environmentId: string, logicalName: string) {
    const [row] = await this.db
      .select({
        displayName: stagedTables.displayName,
        rowCount: stagedTables.rowCount,
        sourceRef: stagedTables.sourceRef,
      })
      .from(stagedTables)
      .where(and(eq(stagedTables.environmentId, environmentId), eq(stagedTables.logicalName, logicalName)));
    return row ?? null;
  }

  private async tableDto(environmentId: string, logicalName: string): Promise<StagedTableDto> {
    const [row] = await this.db
      .select({ table: stagedTables, user: users.displayName })
      .from(stagedTables)
      .leftJoin(users, eq(users.id, stagedTables.importedByUserId))
      .where(and(eq(stagedTables.environmentId, environmentId), eq(stagedTables.logicalName, logicalName)));
    if (!row) throw notFound('Imported table');
    return toDto(row.table, row.user ?? null);
  }

  private async stagedEnvironment(ctx: RequestContext, environmentId: string) {
    const [row] = await this.db
      .select()
      .from(environments)
      .where(and(eq(environments.id, environmentId), eq(environments.organizationId, ctx.organizationId)));
    if (!row) throw notFound('Source');
    if (!isStagedConnection(row.connectionType)) {
      throw badRequest('That connection is a live database; data is read from it rather than imported');
    }
    return row;
  }
}

// ---------------------------------------------------------------------------
// Reading a file into sheets
// ---------------------------------------------------------------------------

const kindOf = (connectionType: string): StagedSourceKind =>
  connectionType === 'ONEDRIVE' ? 'ONEDRIVE' : connectionType === 'SHAREPOINT' ? 'SHAREPOINT' : 'UPLOAD';

/**
 * A workbook's sheets, an XML document's records, or a delimited file as one table.
 *
 * The order matters. Everything that was not a ZIP used to fall through to the delimited reader,
 * which reads anything: an XML export came back as a one-column table of XML fragments, and then
 * profiled, mapped and migrated exactly like a real table. Answering confidently and wrongly is
 * worse than refusing, so each format is recognised before it is read, and one this importer
 * cannot read is named rather than mangled.
 */
export function readSheets(content: Buffer, filename: string): XlsxReadSheet[] {
  const looksZip = content.length > 4 && content[0] === 0x50 && content[1] === 0x4b;
  if (looksZip) {
    try {
      return readXlsx(content);
    } catch (err) {
      throw badRequest(
        `${filename} could not be read as a workbook: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }
  const text = content.toString('utf8');
  if (text.includes('\u0000')) {
    throw badRequest(
      `${filename} is not a text file this importer can read. Export it as CSV, .xlsx or XML and try again.`,
    );
  }
  if (looksLikeXml(content)) {
    try {
      return readXml(content, filename);
    } catch (err) {
      throw badRequest(
        err instanceof XmlReadError
          ? err.message
          : `${filename} could not be read as XML: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }
  const unreadable = unreadableFormat(text);
  if (unreadable) {
    throw badRequest(
      `${filename} looks like ${unreadable}, which this importer cannot read as a table. Export it as CSV, .xlsx or XML and try again.`,
    );
  }
  const name = filename.replace(/\.[^.]+$/, '') || 'data';
  return [{ name, rows: parseDelimited(text) }];
}

/**
 * Names a text format that is definitely not delimited data.
 *
 * Only shapes that are unambiguous. Anything uncertain still goes to the delimited reader, because
 * refusing a valid CSV because it happens to start with a brace would be its own bug.
 */
function unreadableFormat(text: string): string | null {
  const head = text.replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('%PDF-')) return 'a PDF';
  if (/^<!doctype html/i.test(head) || /^<html[\s>]/i.test(head)) return 'an HTML page';
  if (head.startsWith('{') || head.startsWith('[')) return 'JSON';
  return null;
}

/**
 * Splits a delimited file, detecting whether it is comma, semicolon or tab separated.
 *
 * Worth detecting rather than assuming: a CSV exported from a spreadsheet in a locale that uses the
 * comma as a decimal separator is semicolon-delimited, and reading it as commas produces one column
 * of nonsense instead of an error.
 */
export function parseDelimited(text: string): (string | number | boolean | null)[][] {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = stripped.split(/\r?\n/, 1)[0] ?? '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch as keyof typeof counts]++;
  }
  const delimiter = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ',') as string;
  /**
   * Parsed with the delimiter the file actually uses.
   *
   * This used to rewrite a semicolon- or tab-separated file into a comma-separated one and then parse
   * that — which meant doing something about the commas already in the data, and what it did was turn
   * them into spaces. `Smith, John` in an unquoted field became `Smith John` before anything else in the
   * product saw the value: a silent edit to a customer's data, in the subsystem whose whole job is to
   * carry values across unchanged.
   */
  return parseCsvRows(stripped, delimiter);
}

/**
 * Finds the header row and the rows beneath it.
 *
 * Real exports put a title, a date and a blank line above the header, so the first non-empty row
 * with at least two populated cells is taken as the header rather than row 1 unconditionally.
 */
export function prepareSheet(
  sheet: XlsxReadSheet,
): { headers: string[]; rows: (string | number | boolean | null)[][] } | null {
  const rows = sheet.rows ?? [];
  const populated = (row: (string | number | boolean | null)[] | undefined) =>
    (row ?? []).filter((c) => c !== null && c !== undefined && String(c).trim() !== '').length;
  const limit = Math.min(rows.length, 20);
  // Two passes, because a title line is a single populated cell and so is the header of a
  // single-column file. Preferring a multi-column row first tells them apart; only a sheet with no
  // multi-column row at all falls back to a one-column header.
  const candidates = [
    ...Array.from({ length: limit }, (_, i) => i).filter((i) => populated(rows[i]) >= 2),
    ...Array.from({ length: limit }, (_, i) => i).filter((i) => populated(rows[i]) === 1),
  ];
  for (const i of candidates) {
    const headers = (rows[i] ?? []).map((c) => (c === null || c === undefined ? '' : String(c)));
    // Trailing all-empty columns are an artefact of how spreadsheets store a used range.
    while (headers.length && headers[headers.length - 1].trim() === '') headers.pop();
    if (headers.length === 0) continue;
    const body = rows
      .slice(i + 1)
      .filter((r) => (r ?? []).some((c) => c !== null && c !== undefined && String(c).trim() !== ''));
    if (body.length === 0) continue;
    return { headers, rows: body };
  }
  return null;
}

/** A stable, addressable table name from a file or sheet name. */
export function tableNameFor(primary: string, fallback: string): string {
  const base = (primary || fallback || 'table')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 120);
  return base || 'table';
}

const displayNameFor = (sheetName: string, filename: string) =>
  (sheetName || filename.replace(/\.[^.]+$/, '') || 'Imported table').slice(0, 160);

const toDto = (row: typeof stagedTables.$inferSelect, importedBy: string | null): StagedTableDto => ({
  logicalName: row.logicalName,
  displayName: row.displayName,
  kind: row.kind,
  sourceRef: row.sourceRef,
  sheetName: row.sheetName,
  rowCount: row.rowCount,
  columnCount: row.columns.length,
  keyColumn: row.keyColumn,
  keyIsSynthetic: row.keyIsSynthetic,
  importedAt: row.importedAt.toISOString(),
  importedBy,
  columns: row.columns,
});
