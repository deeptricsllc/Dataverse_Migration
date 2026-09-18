/**
 * SQL Server / Azure SQL connector.
 *
 * Every statement is parameterized: source values are bound, never concatenated into SQL text.
 * Identifiers (table and column names) come from the catalog we ourselves read and are quoted with
 * QUOTENAME semantics before use, so no user-supplied string ever reaches the parser as code.
 *
 * Reads are paged by primary key (keyset pagination) so a large table is never loaded into memory,
 * and every connection uses a pool rather than a connection per record.
 */
import sql from 'mssql';
import type { Logger } from 'pino';
import type { AutomationInfo, PrincipalDto, SqlConnectionConfig } from '../../../../shared/domain';
import {
  isLookupValue,
  type AlternateKeyMeta,
  type AttributeMeta,
  type DvRecord,
  type FieldValue,
  type TableMetadata,
  type TableSummary,
} from '../../../../shared/metadata';
import { DataverseError } from '../../dataverse/errors';
import { unsupportedOperation } from '../errors';
import type {
  ConnectionCheck,
  ConnectionTestResult,
  MigrationConnector,
  RecordCount,
  WhoAmI,
  WriteOptions,
  WriteRecord,
} from '../types';
import { SQL_CAPABILITIES } from '../types';
import {
  buildTableMetadata,
  buildTableSummaries,
  COLUMNS_QUERY,
  FOREIGN_KEYS_QUERY,
  PRIMARY_KEYS_QUERY,
  sqlTableName,
  TABLES_QUERY,
  UNIQUE_KEYS_QUERY,
  type SqlColumnRow,
  type SqlFkRow,
  type SqlPkRow,
  type SqlTableRow,
  type SqlUniqueRow,
} from './catalog';

export interface SqlConnectorOptions {
  config: SqlConnectionConfig;
  /** Decrypted password. Held only in memory, never logged and never returned by the API. */
  password: string | null;
  logger: Logger;
  /** When true every write is refused before it reaches the database. */
  readOnly?: boolean;
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  poolMax?: number;
}

/** SQL Server errors that are worth retrying rather than failing a record on. */
const TRANSIENT_SQL_ERRORS = new Set([
  4060, 40197, 40501, 40613, 49918, 49919, 49920, 10928, 10929, 10053, 10054, 10060, 233, 64, 121, 1205,
]);

const WRITE_STATEMENTS = /^\s*(insert|update|delete|merge|drop|alter|create|truncate|exec)/i;

/** Quotes an identifier the way QUOTENAME does, refusing anything that is not an identifier. */
export function quoteIdent(name: string): string {
  if (!/^[\w @#$.]+$/.test(name) || name.length > 128) {
    throw new DataverseError('VALIDATION', `Unsupported SQL identifier: ${name}`, 400);
  }
  return `[${name.replace(/]/g, ']]')}]`;
}

/** `dbo.Customer` -> `[dbo].[Customer]`. */
function quoteTable(logicalName: string): string {
  const idx = logicalName.indexOf('.');
  if (idx < 0) return `[dbo].${quoteIdent(logicalName)}`;
  return `${quoteIdent(logicalName.slice(0, idx))}.${quoteIdent(logicalName.slice(idx + 1))}`;
}

export class SqlConnector implements MigrationConnector {
  readonly provider: 'sqlserver' | 'azuresql';
  readonly url: string;
  readonly capabilities = SQL_CAPABILITIES;
  private pool: sql.ConnectionPool | null = null;
  private poolPromise: Promise<sql.ConnectionPool> | null = null;
  private tableCache: Map<string, TableMetadata> | null = null;

  constructor(
    private readonly opts: SqlConnectorOptions,
    provider: 'sqlserver' | 'azuresql' = 'sqlserver',
  ) {
    this.provider = provider;
    const c = opts.config;
    this.url = `${c.host}:${c.port}/${c.database}`;
  }

  // ---------------------------------------------------------------------------
  // Pool
  // ---------------------------------------------------------------------------

  private async getPool(): Promise<sql.ConnectionPool> {
    if (this.pool?.connected) return this.pool;
    if (!this.poolPromise) {
      const c = this.opts.config;
      if (c.transport === 'AGENT') {
        throw new DataverseError(
          'NETWORK',
          'This connection is configured to use a migration agent, which is not available yet. See docs/ON_PREM_AGENT_ARCHITECTURE.md.',
          503,
          undefined,
          undefined,
          false,
        );
      }
      if (c.authType !== 'SQL_LOGIN') {
        throw new DataverseError(
          'AUTH_REQUIRED',
          `${c.authType} authentication is not implemented yet; use a SQL login.`,
          400,
          undefined,
          undefined,
          false,
        );
      }
      const pool = new sql.ConnectionPool({
        server: c.host,
        port: c.port,
        database: c.database,
        user: c.username ?? undefined,
        password: this.opts.password ?? undefined,
        options: {
          encrypt: c.encrypt,
          trustServerCertificate: c.trustServerCertificate,
          enableArithAbort: true,
        },
        connectionTimeout: this.opts.connectionTimeoutMs ?? 15_000,
        requestTimeout: this.opts.requestTimeoutMs ?? 120_000,
        pool: { max: this.opts.poolMax ?? 5, min: 0, idleTimeoutMillis: 30_000 },
      });
      // A pool error must never take the process down; the next request reconnects.
      pool.on('error', (err) => this.opts.logger.warn({ err: err.message }, 'SQL pool error'));
      this.poolPromise = pool.connect().catch((err) => {
        this.poolPromise = null;
        throw this.toError(err, 'connect');
      });
    }
    this.pool = await this.poolPromise;
    return this.pool;
  }

  async dispose(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    this.poolPromise = null;
    if (pool) await pool.close().catch(() => undefined);
  }

  /**
   * Maps a driver error onto the shared error model, with a message that names the failure but
   * never the credentials or the full connection string.
   */
  private toError(err: unknown, action: string): DataverseError {
    const e = err as { number?: number; code?: string; message?: string };
    const number = e.number;
    const retryable = number !== undefined && TRANSIENT_SQL_ERRORS.has(number);
    const message = (e.message ?? String(err)).replace(/password=[^;]*/gi, 'password=***');
    if (number === 18456 || e.code === 'ELOGIN') {
      return new DataverseError(
        'AUTH_REQUIRED',
        `SQL authentication failed for ${this.url} (login rejected).`,
        401,
        String(number ?? ''),
        undefined,
        false,
      );
    }
    if (e.code === 'ESOCKET' || e.code === 'ETIMEOUT' || e.code === 'ENOTFOUND') {
      return new DataverseError(
        'NETWORK',
        `Cannot reach ${this.url}: ${e.code}. The server may be unreachable from this deployment, or blocked by a firewall.`,
        503,
        e.code,
        undefined,
        true,
      );
    }
    if (number === 229 || number === 230 || number === 297) {
      return new DataverseError(
        'FORBIDDEN',
        `The SQL login does not have permission to ${action}.`,
        403,
        String(number),
        undefined,
        false,
      );
    }
    return new DataverseError(
      retryable ? 'THROTTLED' : 'VALIDATION',
      `SQL ${action} failed: ${message}`,
      retryable ? 503 : 400,
      number === undefined ? undefined : String(number),
      undefined,
      retryable,
    );
  }

  /** Runs a parameterized query. `params` values are bound, never interpolated. */
  private async query<T>(
    text: string,
    params: Record<string, FieldValue> = {},
    action = 'query',
  ): Promise<T[]> {
    if (this.opts.readOnly && WRITE_STATEMENTS.test(text)) {
      throw new DataverseError(
        'READ_ONLY_MODE',
        'Write operations are disabled for this deployment.',
        403,
        undefined,
        undefined,
        false,
      );
    }
    const pool = await this.getPool();
    const request = pool.request();
    for (const [name, value] of Object.entries(params)) request.input(name, this.bind(value));
    try {
      const result = await request.query<T>(text);
      return result.recordset ?? [];
    } catch (err) {
      throw this.toError(err, action);
    }
  }

  /** Normalizes a value for binding: lookups bind their key, dates bind as Date. */
  private bind(value: FieldValue): string | number | boolean | Date | null {
    if (value === null || value === undefined) return null;
    if (isLookupValue(value)) return /^\d+$/.test(value.id) ? Number(value.id) : value.id;
    if (Array.isArray(value)) return value.join(',');
    return value;
  }

  // ---------------------------------------------------------------------------
  // Connection test
  // ---------------------------------------------------------------------------

  async testConnection(): Promise<ConnectionTestResult> {
    const checks: ConnectionCheck[] = [];
    let version: string;
    try {
      const rows = await this.query<{ version: string; db: string }>(
        'SELECT @@VERSION AS version, DB_NAME() AS db',
        {},
        'read server version',
      );
      version = (rows[0]?.version ?? '').split('\n')[0].trim();
      checks.push({ key: 'network', label: 'Server reachable', status: 'PASS', message: this.url });
      checks.push({
        key: 'auth',
        label: 'Authentication',
        status: 'PASS',
        message: `Signed in as the configured SQL login`,
      });
      checks.push({
        key: 'database',
        label: 'Database accessible',
        status: 'PASS',
        message: `${rows[0]?.db ?? this.opts.config.database}${version ? ` — ${version}` : ''}`,
      });
    } catch (err) {
      const e = err as DataverseError;
      const failedAuth = e.code === 'AUTH_REQUIRED';
      checks.push({
        key: 'network',
        label: 'Server reachable',
        status: failedAuth ? 'PASS' : 'FAIL',
        message: failedAuth ? this.url : e.message,
        resolution: failedAuth
          ? null
          : 'Check the host and port, that the SQL Server allows remote TCP connections, and that a firewall is not blocking this deployment. An on-premises server usually needs the migration agent (docs/ON_PREM_AGENT_ARCHITECTURE.md).',
      });
      checks.push({
        key: 'auth',
        label: 'Authentication',
        status: failedAuth ? 'FAIL' : 'NOT_TESTED',
        message: failedAuth ? e.message : 'Not reached',
        resolution: failedAuth ? 'Check the login name and password, and that the login is enabled.' : null,
      });
      checks.push({ key: 'database', label: 'Database accessible', status: 'NOT_TESTED', message: '—' });
      checks.push({ key: 'read', label: 'Read permission', status: 'NOT_TESTED', message: '—' });
      checks.push({
        key: 'write',
        label: 'Write permission',
        status: 'NOT_TESTED',
        message: 'Never probed; a connection test never writes data',
      });
      return { ok: false, summary: e.message, checks };
    }

    try {
      const tables = await this.query<SqlTableRow>(TABLES_QUERY, {}, 'read the catalog');
      checks.push({
        key: 'read',
        label: 'Read permission',
        status: tables.length ? 'PASS' : 'WARN',
        message: tables.length
          ? `${tables.length} tables and views visible to this login`
          : 'Connected, but no tables are visible to this login',
        resolution: tables.length
          ? null
          : 'Grant at least VIEW DEFINITION and SELECT on the tables to migrate.',
      });
    } catch (err) {
      checks.push({
        key: 'read',
        label: 'Read permission',
        status: 'FAIL',
        message: (err as Error).message,
        resolution: 'The login needs VIEW DEFINITION and SELECT. See docs/SQL_SERVER_SETUP.md.',
      });
    }

    // Write permission is deliberately never probed: a connection test must not change data.
    checks.push({
      key: 'write',
      label: 'Write permission',
      status: 'NOT_TESTED',
      message: 'Never probed; a connection test never writes data',
    });
    return {
      ok: checks.every((c) => c.status !== 'FAIL'),
      summary: version || `Connected to ${this.url}`,
      checks,
    };
  }

  // ---------------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------------

  private schemaFilter<T extends { schemaName: string }>(rows: T[]): T[] {
    const wanted = this.opts.config.schemas;
    if (!wanted?.length) return rows;
    const set = new Set(wanted.map((s) => s.toLowerCase()));
    return rows.filter((r) => set.has(r.schemaName.toLowerCase()));
  }

  private async loadCatalog(): Promise<Map<string, TableMetadata>> {
    if (this.tableCache) return this.tableCache;
    const [tables, columns, primaryKeys, uniques, foreignKeys] = await Promise.all([
      this.query<SqlTableRow>(TABLES_QUERY, {}, 'list tables'),
      this.query<SqlColumnRow>(COLUMNS_QUERY, {}, 'list columns'),
      this.query<SqlPkRow>(PRIMARY_KEYS_QUERY, {}, 'list primary keys'),
      this.query<SqlUniqueRow>(UNIQUE_KEYS_QUERY, {}, 'list unique keys'),
      this.query<SqlFkRow>(FOREIGN_KEYS_QUERY, {}, 'list foreign keys'),
    ]);
    const visible = this.schemaFilter(tables);
    const cache = new Map<string, TableMetadata>();
    for (const table of visible) {
      const meta = buildTableMetadata({ table, columns, primaryKeys, uniques, foreignKeys });
      cache.set(meta.logicalName, meta);
    }
    this.tableCache = cache;
    return cache;
  }

  async listTables(): Promise<TableSummary[]> {
    const rows = this.schemaFilter(await this.query<SqlTableRow>(TABLES_QUERY, {}, 'list tables'));
    return buildTableSummaries(rows);
  }

  async getTable(logicalName: string): Promise<TableMetadata> {
    const catalog = await this.loadCatalog();
    const meta = catalog.get(logicalName);
    if (!meta) {
      throw new DataverseError('NOT_FOUND', `Invalid object name '${logicalName}'.`, 404, '208');
    }
    return structuredClone(meta);
  }

  async countRecords(table: TableSummary): Promise<RecordCount> {
    // COUNT_BIG is exact; the catalog's partition statistics are only used if it is refused.
    try {
      const rows = await this.query<{ n: number }>(
        `SELECT COUNT_BIG(1) AS n FROM ${quoteTable(table.logicalName)}`,
        {},
        `count ${table.logicalName}`,
      );
      return { count: Number(rows[0]?.n ?? 0), approximate: false };
    } catch (err) {
      const rows = await this.query<SqlTableRow>(TABLES_QUERY, {}, 'read row counts').catch(() => []);
      const match = rows.find((r) => sqlTableName(r.schemaName, r.tableName) === table.logicalName);
      if (match?.rowCount == null) throw err;
      return { count: Number(match.rowCount), approximate: true };
    }
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  private selectList(table: TableMetadata, columns: string[]): { list: string; attrs: AttributeMeta[] } {
    const byName = new Map(table.attributes.map((a) => [a.logicalName, a]));
    const attrs = [...new Set(columns)]
      .map((c) => byName.get(c))
      .filter((a): a is AttributeMeta => !!a && a.isValidForRead);
    const names = [table.primaryIdAttribute, ...attrs.map((a) => a.logicalName)];
    return { list: [...new Set(names)].map(quoteIdent).join(', '), attrs };
  }

  private toRecord(table: TableMetadata, row: Record<string, unknown>, attrs: AttributeMeta[]): DvRecord {
    const values: Record<string, FieldValue> = {};
    for (const a of attrs) {
      if (a.logicalName === table.primaryIdAttribute) continue;
      const raw = row[a.logicalName];
      values[a.logicalName] = this.fromSql(raw, a);
    }
    return { id: String(row[table.primaryIdAttribute]), values };
  }

  /** Turns a driver value into the normalized model; foreign keys become lookups. */
  private fromSql(raw: unknown, attr: AttributeMeta): FieldValue {
    if (raw === null || raw === undefined) return null;
    if (attr.type === 'Lookup' && attr.targets?.length) {
      return { id: String(raw), logicalName: attr.targets[0] };
    }
    if (raw instanceof Date) {
      return attr.dateTimeBehavior === 'DateOnly' ? raw.toISOString().slice(0, 10) : raw.toISOString();
    }
    if (Buffer.isBuffer(raw)) return raw.toString('base64');
    if (typeof raw === 'bigint') return Number(raw);
    return raw as FieldValue;
  }

  async *queryRecords(
    table: TableMetadata,
    columns: string[],
    opts: { pageSize: number },
  ): AsyncGenerator<DvRecord[]> {
    const { list, attrs } = this.selectList(table, columns);
    const pk = quoteIdent(table.primaryIdAttribute);
    const pageSize = Math.max(1, Math.min(opts.pageSize, 5000));
    let last: FieldValue = null;
    for (;;) {
      // Keyset pagination: ORDER BY the primary key and continue after the last one seen, so the
      // cost does not grow with the offset and a large table is never materialized.
      const text =
        last === null
          ? `SELECT TOP (${pageSize}) ${list} FROM ${quoteTable(table.logicalName)} ORDER BY ${pk}`
          : `SELECT TOP (${pageSize}) ${list} FROM ${quoteTable(table.logicalName)} WHERE ${pk} > @afterKey ORDER BY ${pk}`;
      const rows = await this.query<Record<string, unknown>>(
        text,
        last === null ? {} : { afterKey: last },
        `read ${table.logicalName}`,
      );
      if (rows.length === 0) return;
      const records = rows.map((r) => this.toRecord(table, r, attrs));
      yield records;
      if (rows.length < pageSize) return;
      last = rows[rows.length - 1][table.primaryIdAttribute] as FieldValue;
    }
  }

  async retrieveByIds(table: TableMetadata, ids: string[], columns: string[]): Promise<DvRecord[]> {
    if (ids.length === 0) return [];
    const { list, attrs } = this.selectList(table, columns);
    const out: DvRecord[] = [];
    // Bound the number of parameters per statement; SQL Server allows 2100.
    for (let i = 0; i < ids.length; i += 500) {
      const slice = ids.slice(i, i + 500);
      const params: Record<string, FieldValue> = {};
      const placeholders = slice.map((id, n) => {
        params[`id${n}`] = /^\d+$/.test(id) ? Number(id) : id;
        return `@id${n}`;
      });
      const rows = await this.query<Record<string, unknown>>(
        `SELECT ${list} FROM ${quoteTable(table.logicalName)} WHERE ${quoteIdent(table.primaryIdAttribute)} IN (${placeholders.join(', ')})`,
        params,
        `read ${table.logicalName}`,
      );
      out.push(...rows.map((r) => this.toRecord(table, r, attrs)));
    }
    return out;
  }

  async findByAlternateKey(
    table: TableMetadata,
    key: AlternateKeyMeta,
    values: Record<string, FieldValue>,
    columns: string[],
  ): Promise<DvRecord | null> {
    const criteria = Object.fromEntries(key.attributes.map((a) => [a, values[a] ?? null]));
    const found = await this.findByFields(table, criteria, columns, 2);
    return found[0] ?? null;
  }

  async findByFields(
    table: TableMetadata,
    criteria: Record<string, FieldValue>,
    columns: string[],
    limit: number,
  ): Promise<DvRecord[]> {
    const { list, attrs } = this.selectList(table, columns);
    const params: Record<string, FieldValue> = {};
    const where = Object.entries(criteria).map(([field, value], n) => {
      const column = quoteIdent(field);
      if (value === null) return `${column} IS NULL`;
      params[`p${n}`] = this.bind(value) as FieldValue;
      return `${column} = @p${n}`;
    });
    const rows = await this.query<Record<string, unknown>>(
      `SELECT TOP (${Math.max(1, Math.min(limit, 100))}) ${list} FROM ${quoteTable(table.logicalName)}${
        where.length ? ` WHERE ${where.join(' AND ')}` : ''
      }`,
      params,
      `read ${table.logicalName}`,
    );
    return rows.map((r) => this.toRecord(table, r, attrs));
  }

  // ---------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------

  private writableValues(table: TableMetadata, record: WriteRecord, forCreate: boolean) {
    const attrs = new Map(table.attributes.map((a) => [a.logicalName, a]));
    const params: Record<string, FieldValue> = {};
    const columns: string[] = [];
    for (const [name, value] of Object.entries(record.values)) {
      const a = attrs.get(name);
      if (!a) throw new DataverseError('VALIDATION', `Invalid column name '${name}'.`, 400, '207');
      if (forCreate ? !a.isValidForCreate : !a.isValidForUpdate) continue;
      columns.push(name);
      params[`c${columns.length - 1}`] = this.bind(value) as FieldValue;
    }
    return { columns, params };
  }

  async createRecord(table: TableMetadata, record: WriteRecord, _options: WriteOptions): Promise<string> {
    const pkAttr = table.attributes.find((a) => a.logicalName === table.primaryIdAttribute);
    const { columns, params } = this.writableValues(table, record, true);
    if (columns.length === 0) {
      throw new DataverseError('VALIDATION', `No writable columns for ${table.logicalName}`, 400);
    }
    const identity = pkAttr?.sql?.isIdentity ?? false;
    const insertColumns = [...columns];
    if (!identity && record.id !== undefined && !columns.includes(table.primaryIdAttribute)) {
      params[`c${insertColumns.length}`] = /^\d+$/.test(record.id) ? Number(record.id) : record.id;
      insertColumns.push(table.primaryIdAttribute);
    }
    // OUTPUT INSERTED returns the key the server generated, which is how an identity column's
    // value becomes available for the record identity map.
    const rows = await this.query<Record<string, unknown>>(
      `INSERT INTO ${quoteTable(table.logicalName)} (${insertColumns.map(quoteIdent).join(', ')})
       OUTPUT INSERTED.${quoteIdent(table.primaryIdAttribute)} AS insertedId
       VALUES (${insertColumns.map((_c, i) => `@c${i}`).join(', ')})`,
      params,
      `insert into ${table.logicalName}`,
    );
    const inserted = rows[0]?.insertedId;
    if (inserted === undefined || inserted === null) {
      throw new DataverseError('UNKNOWN', 'Insert succeeded but no key was returned', undefined);
    }
    return String(inserted);
  }

  async updateRecord(
    table: TableMetadata,
    id: string,
    record: WriteRecord,
    _options: WriteOptions,
  ): Promise<void> {
    const { columns, params } = this.writableValues(table, record, false);
    if (columns.length === 0) return; // nothing changed: no statement is sent at all
    params.recordKey = /^\d+$/.test(id) ? Number(id) : id;
    const assignments = columns.map((c, i) => `${quoteIdent(c)} = @c${i}`).join(', ');
    // Always keyed on the primary key: an UPDATE without a deterministic predicate is never issued.
    const result = await this.query<{ affected: number }>(
      `UPDATE ${quoteTable(table.logicalName)} SET ${assignments}
       OUTPUT 1 AS affected
       WHERE ${quoteIdent(table.primaryIdAttribute)} = @recordKey`,
      params,
      `update ${table.logicalName}`,
    );
    if (result.length === 0) {
      throw new DataverseError(
        'NOT_FOUND',
        `No row with ${table.primaryIdAttribute} = ${id} exists in ${table.logicalName}`,
        404,
      );
    }
    if (result.length > 1) {
      // Cannot happen against a primary key, but a corrupt catalog must not silently mass-update.
      throw new DataverseError(
        'VALIDATION',
        `Update matched ${result.length} rows in ${table.logicalName}; expected exactly one`,
        400,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Not applicable to a relational database
  // ---------------------------------------------------------------------------

  async whoAmI(): Promise<WhoAmI> {
    const rows = await this.query<{ login: string; db: string }>(
      'SELECT SUSER_SNAME() AS login, DB_NAME() AS db',
      {},
      'identify the current login',
    );
    return {
      userId: rows[0]?.login ?? this.opts.config.username ?? 'unknown',
      businessUnitId: '',
      organizationId: rows[0]?.db ?? this.opts.config.database,
    };
  }

  async detectAutomation(): Promise<AutomationInfo[]> {
    // Triggers exist, but they are not the Dataverse plug-in concept and are not bypassable here.
    return [];
  }

  async listPrincipals(): Promise<PrincipalDto[]> {
    throw unsupportedOperation('listPrincipals', 'SQL');
  }

  async checkImpersonation(): Promise<{ allowed: boolean; message: string }> {
    return {
      allowed: false,
      message: 'SQL Server has no record ownership or impersonated attribution to preserve.',
    };
  }
}
