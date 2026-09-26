import mysql from 'mysql2/promise';
import type { Logger } from 'pino';
import type { AutomationInfo, PrincipalDto, SqlConnectionConfig } from '../../../../shared/domain';
import {
  type AlternateKeyMeta,
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
  ReadOptions,
  RecordCount,
  WhoAmI,
  WriteOptions,
  WriteRecord,
} from '../types';
import { SQL_CAPABILITIES } from '../types';
import {
  buildTableMetadata,
  buildTableSummaries,
  type SqlColumnRow,
  type SqlFkRow,
  type SqlPkRow,
  type SqlTableRow,
  type SqlTypeVocabulary,
  type SqlUniqueRow,
} from './catalog';
import {
  MYSQL_COLUMNS_QUERY,
  MYSQL_FOREIGN_KEYS_QUERY,
  MYSQL_PRIMARY_KEYS_QUERY,
  MYSQL_TABLES_QUERY,
  MYSQL_UNIQUE_KEYS_QUERY,
  MYSQL_UNSUPPORTED_TYPES,
  MYSQL_VERSION_QUERY,
  MYSQL_WHOAMI_QUERY,
  mysqlCharLength,
  mysqlDateTimeBehavior,
  mysqlIntegerRange,
  mysqlToAttributeType,
} from './mysql-catalog';
import { schemaFilter, selectList, toPositional, toRecord, watermarkColumn, writableValues } from './shared';

/**
 * MySQL and MariaDB as a source or a target.
 *
 * Two things separate it from the other SQL connectors and shape most of what follows. It has no
 * schema layer — a "schema" is a database — so a table has no qualifier. And it has no `RETURNING`
 * clause, so a key generated on insert has to be read back afterwards rather than in the same
 * statement. Everything that does not depend on which server is answering is shared with the others.
 */

const MYSQL_TYPES: SqlTypeVocabulary = {
  toAttributeType: mysqlToAttributeType,
  charLength: mysqlCharLength,
  integerRange: mysqlIntegerRange,
  dateTimeBehavior: mysqlDateTimeBehavior,
  unsupported: MYSQL_UNSUPPORTED_TYPES,
};

/** Errors worth another attempt: the connection dropped, a lock timed out, or a deadlock. */
const TRANSIENT_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'EPIPE',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'ER_TOO_MANY_USER_CONNECTIONS',
  'ER_CON_COUNT_ERROR',
]);

const WRITE_STATEMENTS = /^\s*(insert|update|delete|replace|drop|alter|create|truncate|call|grant|revoke)/i;

export interface MysqlConnectorOptions {
  config: SqlConnectionConfig;
  password: string | null;
  logger: Logger;
  readOnly?: boolean;
  connectionTimeoutMs?: number;
  poolMax?: number;
}

/**
 * `` `name` `` — MySQL quotes with backticks and escapes an embedded one by doubling it.
 *
 * Refused rather than escaped: an empty name, one over 64 characters (MySQL's limit, so it never
 * named a real column) and anything containing a NUL or a backslash, because backslash is an escape
 * character inside MySQL identifiers under some SQL modes and reasoning about which is not worth it.
 */
export function mysqlQuoteIdent(name: string): string {
  if (!name || name.length > 64 || name.includes('\u0000') || name.includes('\\')) {
    throw new DataverseError('VALIDATION', `Invalid identifier '${name}'.`, 400, 'IDENT');
  }
  return `\`${name.replace(/`/g, '``')}\``;
}

/**
 * A table name for MySQL.
 *
 * MySQL has no schema inside a database, so a name that arrives qualified is taken as
 * `database.table` only when the qualifier is not the connected database — otherwise the qualifier is
 * dropped. Emitting `mydb.customer` while connected to `mydb` works, but emitting it when the
 * catalogue reported the schema as the database name and the connection has since changed would not.
 */
export function mysqlQuoteTable(logicalName: string, database: string): string {
  const dot = logicalName.indexOf('.');
  if (dot <= 0) return mysqlQuoteIdent(logicalName);
  const schema = logicalName.slice(0, dot);
  const table = logicalName.slice(dot + 1);
  return schema.toLowerCase() === database.toLowerCase()
    ? mysqlQuoteIdent(table)
    : `${mysqlQuoteIdent(schema)}.${mysqlQuoteIdent(table)}`;
}

export class MysqlConnector implements MigrationConnector {
  readonly provider = 'mysql' as const;
  readonly url: string;
  readonly capabilities = SQL_CAPABILITIES;
  private pool: mysql.Pool | null = null;
  private catalog: Map<string, TableMetadata> | null = null;

  constructor(private readonly opts: MysqlConnectorOptions) {
    const c = opts.config;
    this.url = `${c.host}:${c.port}/${c.database}`;
  }

  private get database(): string {
    return this.opts.config.database;
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  private async getPool(): Promise<mysql.Pool> {
    if (this.pool) return this.pool;
    const c = this.opts.config;
    if (c.transport === 'AGENT') {
      throw new DataverseError(
        'VALIDATION',
        'This connection is configured to route through an on-premises agent, which is not implemented yet.',
        400,
        'TRANSPORT_UNSUPPORTED',
      );
    }
    if (c.authType !== 'SQL_LOGIN') {
      throw new DataverseError(
        'VALIDATION',
        `MySQL connections support password authentication; ${c.authType} is not implemented.`,
        400,
        'AUTH_UNSUPPORTED',
      );
    }
    this.pool = mysql.createPool({
      host: c.host,
      port: c.port,
      database: c.database,
      user: c.username ?? undefined,
      password: this.opts.password ?? undefined,
      ssl: c.encrypt ? { rejectUnauthorized: !c.trustServerCertificate } : undefined,
      connectionLimit: this.opts.poolMax ?? 4,
      connectTimeout: this.opts.connectionTimeoutMs ?? 15_000,
      // Dates as strings, because the normalized model stores an instant as text and letting the
      // driver build a Date in the server's local zone would shift it.
      dateStrings: true,
      // Exact numerics as strings rather than losing precision in a float.
      decimalNumbers: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      // Several statements in one call is the shape an injection needs; it is off by default and is
      // stated here so it stays off.
      multipleStatements: false,
      timezone: 'Z',
    });
    return this.pool;
  }

  async dispose(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    await pool?.end().catch(() => undefined);
  }

  /** A driver error in the platform's own vocabulary, with any credential scrubbed out. */
  private toError(err: unknown, action: string): DataverseError {
    const e = err as { code?: string; errno?: number; sqlMessage?: string; message?: string };
    const code = e?.code ?? '';
    // No local redaction: DataverseError scrubs every message it carries.
    const message = e?.sqlMessage ?? e?.message ?? String(err);

    if (code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR' || e?.errno === 1045) {
      return new DataverseError(
        'AUTH_REQUIRED',
        `MySQL rejected the credentials for ${action}: ${message}`,
        401,
        code,
      );
    }
    if (code === 'ER_BAD_DB_ERROR') {
      return new DataverseError('NOT_FOUND', `The database does not exist: ${message}`, 404, code);
    }
    if (code === 'ER_NO_SUCH_TABLE') {
      return new DataverseError('NOT_FOUND', `Unknown table during ${action}: ${message}`, 404, code);
    }
    if (code === 'ER_TABLEACCESS_DENIED_ERROR' || code === 'ER_COLUMNACCESS_DENIED_ERROR') {
      return new DataverseError(
        'FORBIDDEN',
        `The login is not permitted to ${action}: ${message}`,
        403,
        code,
      );
    }
    if (code === 'ER_DUP_ENTRY') {
      return new DataverseError('DUPLICATE_RECORD', `Unique constraint violated: ${message}`, 409, code);
    }
    if (code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_ROW_IS_REFERENCED_2') {
      return new DataverseError('REFERENCE_NOT_FOUND', `Foreign key violated: ${message}`, 400, code);
    }
    if (code === 'ER_BAD_NULL_ERROR' || code === 'ER_DATA_TOO_LONG' || code === 'ER_TRUNCATED_WRONG_VALUE') {
      return new DataverseError('VALIDATION', `${action} was rejected: ${message}`, 400, code);
    }
    if (code === 'ETIMEDOUT' || code === 'ER_QUERY_TIMEOUT') {
      return new DataverseError('TIMEOUT', `${action} timed out: ${message}`, 504, code);
    }
    if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH'].includes(code) || TRANSIENT_CODES.has(code)) {
      return new DataverseError(
        'NETWORK',
        `Could not reach the MySQL server for ${action}: ${message}`,
        503,
        code,
      );
    }
    return new DataverseError('SERVER_ERROR', `${action} failed: ${message}`, 500, code || undefined);
  }

  /** Every statement goes through here, so the read-only guard cannot be bypassed. */
  private async query<T>(
    text: string,
    params: Record<string, FieldValue> = {},
    action = 'query',
  ): Promise<T[]> {
    if (this.opts.readOnly && WRITE_STATEMENTS.test(text)) {
      throw new DataverseError(
        'FORBIDDEN',
        'This deployment is read-only: writes to a real database are blocked.',
        403,
        'READ_ONLY',
      );
    }
    // MySQL's placeholders are anonymous, so a repeated name is bound once per occurrence.
    const { text: sqlText, values } = toPositional(text, params, 'question');
    try {
      const pool = await this.getPool();
      const [rows] = await pool.query(sqlText, values);
      return (Array.isArray(rows) ? rows : []) as T[];
    } catch (err) {
      throw this.toError(err, action);
    }
  }

  /** An insert or update, which needs the result header rather than rows. */
  private async execute(
    text: string,
    params: Record<string, FieldValue>,
    action: string,
  ): Promise<mysql.ResultSetHeader> {
    if (this.opts.readOnly) {
      throw new DataverseError(
        'FORBIDDEN',
        'This deployment is read-only: writes to a real database are blocked.',
        403,
        'READ_ONLY',
      );
    }
    const { text: sqlText, values } = toPositional(text, params, 'question');
    try {
      const pool = await this.getPool();
      const [header] = await pool.execute(sqlText, values);
      return header as mysql.ResultSetHeader;
    } catch (err) {
      throw this.toError(err, action);
    }
  }

  // ---------------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------------

  async testConnection(): Promise<ConnectionTestResult> {
    const checks: ConnectionCheck[] = [];
    let version: string;
    try {
      const rows = await this.query<{ version: string; db: string }>(
        MYSQL_VERSION_QUERY,
        {},
        'read the server version',
      );
      version = (rows[0]?.version ?? '').trim();
      checks.push({ key: 'network', label: 'Server reachable', status: 'PASS', message: this.url });
      checks.push({
        key: 'auth',
        label: 'Authentication',
        status: 'PASS',
        message: 'Signed in as the configured MySQL user',
      });
      checks.push({
        key: 'database',
        label: 'Database accessible',
        status: rows[0]?.db ? 'PASS' : 'WARN',
        message: rows[0]?.db
          ? `${rows[0].db}${version ? ` — MySQL ${version}` : ''}`
          : 'Connected, but no database is selected for this connection',
        resolution: rows[0]?.db ? null : 'Set the database this connection should read.',
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
          : 'Check the host and port, that MySQL is listening on TCP (bind-address) and that a firewall is not blocking this deployment.',
      });
      checks.push({
        key: 'auth',
        label: 'Authentication',
        status: failedAuth ? 'FAIL' : 'NOT_TESTED',
        message: failedAuth ? e.message : 'Not reached',
        resolution: failedAuth
          ? "Check the user and password, and that the account is allowed to connect from this deployment's address."
          : null,
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
      const tables = await this.query<SqlTableRow>(MYSQL_TABLES_QUERY, {}, 'read the catalog');
      const visible = schemaFilter(tables, this.opts.config.schemas);
      checks.push({
        key: 'read',
        label: 'Read permission',
        status: visible.length > 0 ? 'PASS' : 'WARN',
        message:
          visible.length > 0
            ? `${visible.length} table(s) and view(s) visible`
            : 'Connected, but no tables are visible to this user',
        resolution: visible.length > 0 ? null : 'Grant SELECT on the tables to migrate.',
      });
    } catch (err) {
      const e = err as DataverseError;
      checks.push({
        key: 'read',
        label: 'Read permission',
        status: 'FAIL',
        message: e.message,
        resolution: 'Grant SELECT on the tables to migrate.',
      });
    }
    checks.push({
      key: 'write',
      label: 'Write permission',
      status: 'NOT_TESTED',
      message: 'Never probed; a connection test never writes data',
    });
    const readable = checks.find((c) => c.key === 'read')?.status !== 'FAIL';
    return { ok: readable, summary: version ? `MySQL ${version}` : `Connected to ${this.database}`, checks };
  }

  private async loadCatalog(): Promise<Map<string, TableMetadata>> {
    if (this.catalog) return this.catalog;
    const [tables, columns, primaryKeys, uniques, foreignKeys] = await Promise.all([
      this.query<SqlTableRow>(MYSQL_TABLES_QUERY, {}, 'read tables'),
      this.query<SqlColumnRow>(MYSQL_COLUMNS_QUERY, {}, 'read columns'),
      this.query<SqlPkRow>(MYSQL_PRIMARY_KEYS_QUERY, {}, 'read primary keys'),
      this.query<SqlUniqueRow>(MYSQL_UNIQUE_KEYS_QUERY, {}, 'read unique keys'),
      this.query<SqlFkRow>(MYSQL_FOREIGN_KEYS_QUERY, {}, 'read foreign keys'),
    ]);
    const map = new Map<string, TableMetadata>();
    for (const table of schemaFilter(tables, this.opts.config.schemas)) {
      const meta = buildTableMetadata({ table, columns, primaryKeys, uniques, foreignKeys }, MYSQL_TYPES);
      map.set(meta.logicalName, meta);
    }
    this.catalog = map;
    return map;
  }

  async listTables(): Promise<TableSummary[]> {
    const rows = await this.query<SqlTableRow>(MYSQL_TABLES_QUERY, {}, 'read tables');
    return buildTableSummaries(schemaFilter(rows, this.opts.config.schemas));
  }

  async getTable(logicalName: string): Promise<TableMetadata> {
    const catalog = await this.loadCatalog();
    const meta =
      catalog.get(logicalName) ??
      catalog.get(`${this.database}.${logicalName}`) ??
      [...catalog.values()].find((m) => m.logicalName.split('.').pop() === logicalName);
    if (!meta) {
      throw new DataverseError('NOT_FOUND', `Unknown table '${logicalName}'.`, 404, 'ER_NO_SUCH_TABLE');
    }
    return meta;
  }

  async countRecords(table: TableSummary): Promise<RecordCount> {
    try {
      const [row] = await this.query<{ n: string | number }>(
        `SELECT COUNT(*) AS n FROM ${this.quoteTable(table.logicalName)}`,
        {},
        `count ${table.logicalName}`,
      );
      return { count: Number(row?.n ?? 0), approximate: false };
    } catch {
      // InnoDB's TABLE_ROWS is an estimate and can be far out, which is precisely why the fallback
      // is labelled approximate rather than quietly used as a count.
      const rows = await this.query<SqlTableRow>(MYSQL_TABLES_QUERY, {}, 'read row estimates');
      const found = rows.find((r) => `${r.schemaName}.${r.tableName}` === table.logicalName);
      return { count: Number(found?.rowCount ?? 0), approximate: true };
    }
  }

  private quoteTable(logicalName: string): string {
    return mysqlQuoteTable(logicalName, this.database);
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  async *queryRecords(
    table: TableMetadata,
    columns: string[],
    opts: ReadOptions,
  ): AsyncGenerator<DvRecord[]> {
    const { list, attrs } = selectList(table, columns, mysqlQuoteIdent);
    const pk = mysqlQuoteIdent(table.primaryIdAttribute);
    const pageSize = Math.max(1, Math.min(opts.pageSize, 5000));
    const since = opts.since ? watermarkColumn(table, opts.since.field) : null;
    let last: FieldValue = null;
    for (;;) {
      // Keyset pagination, ordered by the primary key: the cost does not grow with the offset, and a
      // large table is never materialized.
      const where = [
        since ? `${mysqlQuoteIdent(since)} > @since` : '',
        last === null ? '' : `${pk} > @afterKey`,
      ].filter(Boolean);
      const text = `SELECT ${list} FROM ${this.quoteTable(table.logicalName)}${
        where.length ? ` WHERE ${where.join(' AND ')}` : ''
      } ORDER BY ${pk} LIMIT ${pageSize}`;
      const rows = await this.query<Record<string, unknown>>(
        text,
        {
          ...(since ? { since: opts.since!.value } : {}),
          ...(last === null ? {} : { afterKey: last }),
        },
        `read ${table.logicalName}`,
      );
      if (rows.length === 0) return;
      yield rows.map((r) => toRecord(table, r, attrs));
      if (rows.length < pageSize) return;
      last = rows[rows.length - 1][table.primaryIdAttribute] as FieldValue;
    }
  }

  async retrieveByIds(table: TableMetadata, ids: string[], columns: string[]): Promise<DvRecord[]> {
    if (ids.length === 0) return [];
    const { list, attrs } = selectList(table, columns, mysqlQuoteIdent);
    const out: DvRecord[] = [];
    // MySQL's default max_allowed_packet makes a very long IN list a risk, so ids are chunked.
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const params: Record<string, FieldValue> = {};
      const placeholders = chunk.map((id, n) => {
        params[`id${n}`] = id;
        return `@id${n}`;
      });
      const rows = await this.query<Record<string, unknown>>(
        `SELECT ${list} FROM ${this.quoteTable(table.logicalName)} WHERE ${mysqlQuoteIdent(
          table.primaryIdAttribute,
        )} IN (${placeholders.join(', ')})`,
        params,
        `read ${table.logicalName} by id`,
      );
      out.push(...rows.map((r) => toRecord(table, r, attrs)));
    }
    return out;
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
    const { list, attrs } = selectList(table, columns, mysqlQuoteIdent);
    const params: Record<string, FieldValue> = {};
    const predicates: string[] = [];
    for (const [name, value] of Object.entries(criteria)) {
      const column = mysqlQuoteIdent(name);
      if (value === null || value === undefined) {
        predicates.push(`${column} IS NULL`);
        continue;
      }
      const key = `p${predicates.length}`;
      params[key] = value;
      predicates.push(`${column} = @${key}`);
    }
    if (predicates.length === 0) return [];
    const rows = await this.query<Record<string, unknown>>(
      `SELECT ${list} FROM ${this.quoteTable(table.logicalName)} WHERE ${predicates.join(
        ' AND ',
      )} LIMIT ${Math.max(1, Math.min(limit, 100))}`,
      params,
      `find in ${table.logicalName}`,
    );
    return rows.map((r) => toRecord(table, r, attrs));
  }

  // ---------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------

  /**
   * Inserts a row and returns its key.
   *
   * MySQL has no `RETURNING`, so an auto-increment key comes from the result header's `insertId`.
   * When the key is not auto-increment the supplied one is authoritative — reading `insertId` there
   * would return 0 and hand the caller a record id that does not exist.
   */
  async createRecord(table: TableMetadata, record: WriteRecord, _options: WriteOptions): Promise<string> {
    const pkAttr = table.attributes.find((a) => a.logicalName === table.primaryIdAttribute);
    const autoKey = pkAttr?.sql?.isIdentity ?? false;
    const { columns, params } = writableValues(table, record, true);
    const insertColumns = [...columns];
    if (record.id && !autoKey && !columns.includes(table.primaryIdAttribute)) {
      insertColumns.push(table.primaryIdAttribute);
      params[`c${insertColumns.length - 1}`] = record.id;
    }
    if (insertColumns.length === 0) {
      throw new DataverseError('VALIDATION', 'No writable columns were supplied.', 400, 'NO_COLUMNS');
    }
    const header = await this.execute(
      `INSERT INTO ${this.quoteTable(table.logicalName)} (${insertColumns
        .map(mysqlQuoteIdent)
        .join(', ')}) VALUES (${insertColumns.map((_c, i) => `@c${i}`).join(', ')})`,
      params,
      `insert into ${table.logicalName}`,
    );
    if (autoKey) {
      if (!header.insertId) {
        throw new DataverseError(
          'SERVER_ERROR',
          `The insert into ${table.logicalName} did not report a generated key.`,
          500,
        );
      }
      return String(header.insertId);
    }
    const supplied = record.id ?? record.values[table.primaryIdAttribute];
    if (supplied === null || supplied === undefined) {
      throw new DataverseError(
        'VALIDATION',
        `${table.logicalName} has no auto-increment key, so a value for ${table.primaryIdAttribute} must be supplied.`,
        400,
      );
    }
    return String(supplied);
  }

  async updateRecord(
    table: TableMetadata,
    id: string,
    record: WriteRecord,
    _options: WriteOptions,
  ): Promise<void> {
    const { columns, params } = writableValues(table, record, false);
    if (columns.length === 0) return;
    const assignments = columns.map((c, i) => `${mysqlQuoteIdent(c)} = @c${i}`).join(', ');
    params.recordKey = id;
    const header = await this.execute(
      `UPDATE ${this.quoteTable(table.logicalName)} SET ${assignments} WHERE ${mysqlQuoteIdent(
        table.primaryIdAttribute,
      )} = @recordKey`,
      params,
      `update ${table.logicalName}`,
    );
    // `affectedRows` counts rows the WHERE matched, so zero means the record is not there. It is not
    // `changedRows`, which would be zero for an update that set every column to what it already held
    // — that is a successful no-op, not a missing record.
    if (header.affectedRows === 0) {
      throw new DataverseError(
        'NOT_FOUND',
        `No row in ${table.logicalName} has ${table.primaryIdAttribute} = ${id}.`,
        404,
      );
    }
    if (header.affectedRows > 1) {
      throw new DataverseError(
        'VALIDATION',
        `${header.affectedRows} rows in ${table.logicalName} share ${table.primaryIdAttribute} = ${id}.`,
        400,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Dataverse-only surface
  // ---------------------------------------------------------------------------

  async whoAmI(): Promise<WhoAmI> {
    const [row] = await this.query<{ login: string; db: string }>(
      MYSQL_WHOAMI_QUERY,
      {},
      'read the current user',
    );
    return {
      userId: row?.login ?? 'unknown',
      businessUnitId: row?.db ?? '',
      organizationId: row?.db ?? '',
    };
  }

  async detectAutomation(): Promise<AutomationInfo[]> {
    // Triggers exist, but they are not the plug-in/flow model this reports, and inventing an
    // equivalence would be worse than reporting nothing.
    return [];
  }

  async listPrincipals(): Promise<PrincipalDto[]> {
    throw unsupportedOperation('listPrincipals', 'MySQL');
  }

  async checkImpersonation(): Promise<{ allowed: boolean; message: string }> {
    return { allowed: false, message: 'MySQL connections do not impersonate users.' };
  }
}

export { MYSQL_TYPES };
