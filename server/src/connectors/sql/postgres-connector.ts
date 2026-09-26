import pg from 'pg';
import type { Logger } from 'pino';
import type { AutomationInfo, PrincipalDto, SqlConnectionConfig } from '../../../../shared/domain';
import {
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
  sqlTableName,
  type SqlColumnRow,
  type SqlFkRow,
  type SqlPkRow,
  type SqlTableRow,
  type SqlTypeVocabulary,
  type SqlUniqueRow,
} from './catalog';
import {
  PG_COLUMNS_QUERY,
  PG_FOREIGN_KEYS_QUERY,
  PG_PRIMARY_KEYS_QUERY,
  PG_TABLES_QUERY,
  PG_UNIQUE_KEYS_QUERY,
  PG_UNSUPPORTED_TYPES,
  PG_VERSION_QUERY,
  PG_WHOAMI_QUERY,
  pgCharLength,
  pgDateTimeBehavior,
  pgIntegerRange,
  pgToAttributeType,
} from './postgres-catalog';
import {
  fromSql,
  schemaFilter,
  selectList,
  toPositional,
  toRecord,
  watermarkColumn,
  writableValues,
} from './shared';

/**
 * PostgreSQL as a source or a target.
 *
 * Deliberately not a subclass of the SQL Server connector and not a "generic SQL" connector:
 * paging, quoting, identity, returning clauses and error codes all differ, and a shared abstraction
 * over them would be an abstraction over four incompatible things. What *is* shared is everything
 * that does not depend on the server — normalizing a row, deciding which columns a write may touch,
 * turning a catalog into metadata — and that lives in `shared.ts` and `catalog.ts`, used by both.
 *
 * Every query is parameterized. The SQL is written with `@name` placeholders like the rest of the
 * codebase and rewritten to PostgreSQL's positional form in one place, so no value is ever
 * concatenated into a statement.
 */

const PG_TYPES: SqlTypeVocabulary = {
  toAttributeType: pgToAttributeType,
  charLength: pgCharLength,
  integerRange: pgIntegerRange,
  dateTimeBehavior: pgDateTimeBehavior,
  unsupported: PG_UNSUPPORTED_TYPES,
};

/** SQLSTATE classes worth another attempt: connection lost, deadlock, or the server restarting. */
const TRANSIENT_SQLSTATES = new Set([
  '08000',
  '08003',
  '08006',
  '08001',
  '08004',
  '40001',
  '40P01',
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

const WRITE_STATEMENTS = /^\s*(insert|update|delete|drop|alter|create|truncate|call|do|grant|revoke)/i;

export interface PostgresConnectorOptions {
  config: SqlConnectionConfig;
  password: string | null;
  logger: Logger;
  readOnly?: boolean;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
  poolMax?: number;
}

/**
 * `"name"` — PostgreSQL folds unquoted identifiers to lower case, so everything is quoted and the
 * catalog's exact casing is preserved. An embedded quote is doubled; anything with a NUL or an
 * unreasonable length is refused rather than escaped, because it cannot be a real column here.
 */
export function pgQuoteIdent(name: string): string {
  if (!name || name.length > 63 || name.includes('\u0000')) {
    throw new DataverseError('VALIDATION', `Invalid identifier '${name}'.`, 400, 'IDENT');
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** `public.Customer` -> `"public"."Customer"`, defaulting to the `public` schema. */
export function pgQuoteTable(logicalName: string): string {
  const dot = logicalName.indexOf('.');
  const schema = dot > 0 ? logicalName.slice(0, dot) : 'public';
  const table = dot > 0 ? logicalName.slice(dot + 1) : logicalName;
  return `${pgQuoteIdent(schema)}.${pgQuoteIdent(table)}`;
}

export class PostgresConnector implements MigrationConnector {
  readonly provider = 'postgres' as const;
  readonly url: string;
  readonly capabilities = SQL_CAPABILITIES;
  private pool: pg.Pool | null = null;
  private catalog: Map<string, TableMetadata> | null = null;

  constructor(private readonly opts: PostgresConnectorOptions) {
    const c = opts.config;
    this.url = `${c.host}:${c.port}/${c.database}`;
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  private async getPool(): Promise<pg.Pool> {
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
        `PostgreSQL connections support password authentication; ${c.authType} is not implemented.`,
        400,
        'AUTH_UNSUPPORTED',
      );
    }
    this.pool = new pg.Pool({
      host: c.host,
      port: c.port,
      database: c.database,
      user: c.username ?? undefined,
      password: this.opts.password ?? undefined,
      // `trustServerCertificate` is the existing field for "this server presents a certificate I
      // cannot verify", which for PostgreSQL means TLS without verification rather than no TLS.
      ssl: c.encrypt ? { rejectUnauthorized: !c.trustServerCertificate } : false,
      max: this.opts.poolMax ?? 4,
      connectionTimeoutMillis: this.opts.connectionTimeoutMs ?? 15_000,
      statement_timeout: this.opts.statementTimeoutMs ?? 120_000,
      application_name: 'deeptrics-migration',
    });
    return this.pool;
  }

  async dispose(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    await pool?.end().catch(() => undefined);
  }

  /**
   * A driver error in the platform's own vocabulary, by SQLSTATE rather than by message text.
   *
   * The message is scrubbed: a connection string can carry a password, and an error is the one place
   * it tends to escape into a log.
   */
  private toError(err: unknown, action: string): DataverseError {
    const e = err as { code?: string; message?: string; severity?: string };
    const code = e?.code ?? '';
    const message = (e?.message ?? String(err)).replace(/password=[^;\s]*/gi, 'password=***');

    if (code === '28P01' || code === '28000') {
      return new DataverseError(
        'AUTH_REQUIRED',
        `PostgreSQL rejected the credentials for ${action}: ${message}`,
        401,
        code,
      );
    }
    if (code === '3D000') {
      return new DataverseError('NOT_FOUND', `The database does not exist: ${message}`, 404, code);
    }
    if (code === '42501' || code === '42000') {
      return new DataverseError(
        'FORBIDDEN',
        `The login is not permitted to ${action}: ${message}`,
        403,
        code,
      );
    }
    if (code === '42P01') {
      return new DataverseError('NOT_FOUND', `Undefined table during ${action}: ${message}`, 404, code);
    }
    if (code === '23505') {
      return new DataverseError('VALIDATION', `Unique constraint violated: ${message}`, 409, code);
    }
    if (code === '23503') {
      return new DataverseError('VALIDATION', `Foreign key violated: ${message}`, 400, code);
    }
    if (code === '23502' || code === '22001' || code === '22003' || code === '22P02') {
      return new DataverseError('VALIDATION', `${action} was rejected: ${message}`, 400, code);
    }
    const networkish = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET'];
    if (code === 'ETIMEDOUT' || code === '57014') {
      return new DataverseError('TIMEOUT', `${action} timed out: ${message}`, 504, code);
    }
    // NETWORK and TIMEOUT are the codes the retry policy treats as worth another attempt, so a
    // transient failure has to arrive as one of them rather than as a generic server error.
    if (networkish.includes(code) || TRANSIENT_SQLSTATES.has(code)) {
      return new DataverseError(
        'NETWORK',
        `Could not reach the PostgreSQL server for ${action}: ${message}`,
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
    const { text: sqlText, values } = toPositional(text, params);
    try {
      const pool = await this.getPool();
      const result = await pool.query(sqlText, values);
      return (result.rows ?? []) as T[];
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
        PG_VERSION_QUERY,
        {},
        'read the server version',
      );
      version = (rows[0]?.version ?? '').split('\n')[0].trim();
      checks.push({ key: 'network', label: 'Server reachable', status: 'PASS', message: this.url });
      checks.push({
        key: 'auth',
        label: 'Authentication',
        status: 'PASS',
        message: 'Signed in as the configured PostgreSQL role',
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
          : 'Check the host and port, that PostgreSQL is listening on TCP (listen_addresses) and that pg_hba.conf and any firewall allow a connection from this deployment.',
      });
      checks.push({
        key: 'auth',
        label: 'Authentication',
        status: failedAuth ? 'FAIL' : 'NOT_TESTED',
        message: failedAuth ? e.message : 'Not reached',
        resolution: failedAuth
          ? 'Check the role name and password, and that pg_hba.conf permits password authentication for it.'
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
      const tables = await this.query<SqlTableRow>(PG_TABLES_QUERY, {}, 'read the catalog');
      const visible = schemaFilter(tables, this.opts.config.schemas);
      checks.push({
        key: 'read',
        label: 'Read permission',
        status: visible.length > 0 ? 'PASS' : 'WARN',
        message:
          visible.length > 0
            ? `${visible.length} table(s) and view(s) visible`
            : 'Connected, but no tables are visible to this role',
        resolution:
          visible.length > 0
            ? null
            : 'Grant USAGE on the schema and SELECT on its tables, or widen the schemas this connection reads.',
      });
    } catch (err) {
      const e = err as DataverseError;
      checks.push({
        key: 'read',
        label: 'Read permission',
        status: 'FAIL',
        message: e.message,
        resolution: 'Grant USAGE on the schema and SELECT on the tables to migrate.',
      });
    }
    // Write permission is never probed: finding out by writing is not a test.
    checks.push({
      key: 'write',
      label: 'Write permission',
      status: 'NOT_TESTED',
      message: 'Never probed; a connection test never writes data',
    });
    const readable = checks.find((c) => c.key === 'read')?.status !== 'FAIL';
    return {
      ok: readable,
      summary: version || `Connected to ${this.opts.config.database}`,
      checks,
    };
  }

  private async loadCatalog(): Promise<Map<string, TableMetadata>> {
    if (this.catalog) return this.catalog;
    const [tables, columns, primaryKeys, uniques, foreignKeys] = await Promise.all([
      this.query<SqlTableRow>(PG_TABLES_QUERY, {}, 'read tables'),
      this.query<SqlColumnRow>(PG_COLUMNS_QUERY, {}, 'read columns'),
      this.query<SqlPkRow>(PG_PRIMARY_KEYS_QUERY, {}, 'read primary keys'),
      this.query<SqlUniqueRow>(PG_UNIQUE_KEYS_QUERY, {}, 'read unique keys'),
      this.query<SqlFkRow>(PG_FOREIGN_KEYS_QUERY, {}, 'read foreign keys'),
    ]);
    const visible = schemaFilter(tables, this.opts.config.schemas);
    const map = new Map<string, TableMetadata>();
    for (const table of visible) {
      const meta = buildTableMetadata({ table, columns, primaryKeys, uniques, foreignKeys }, PG_TYPES);
      map.set(meta.logicalName, meta);
    }
    this.catalog = map;
    return map;
  }

  async listTables(): Promise<TableSummary[]> {
    const rows = await this.query<SqlTableRow>(PG_TABLES_QUERY, {}, 'read tables');
    return buildTableSummaries(schemaFilter(rows, this.opts.config.schemas));
  }

  async getTable(logicalName: string): Promise<TableMetadata> {
    const catalog = await this.loadCatalog();
    const meta = catalog.get(logicalName) ?? catalog.get(withPublicSchema(logicalName));
    if (!meta) {
      throw new DataverseError('NOT_FOUND', `Undefined table '${logicalName}'.`, 404, '42P01');
    }
    return meta;
  }

  async countRecords(table: TableSummary): Promise<RecordCount> {
    try {
      const [row] = await this.query<{ n: string | number }>(
        `SELECT count(*) AS "n" FROM ${pgQuoteTable(table.logicalName)}`,
        {},
        `count ${table.logicalName}`,
      );
      return { count: Number(row?.n ?? 0), approximate: false };
    } catch {
      // A table too large or locked to count exactly still has a planner estimate, which is better
      // than nothing as long as it is reported as an estimate.
      const rows = await this.query<SqlTableRow>(PG_TABLES_QUERY, {}, 'read row estimates');
      const found = rows.find((r) => sqlTableName(r.schemaName, r.tableName) === table.logicalName);
      return { count: Number(found?.rowCount ?? 0), approximate: true };
    }
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  async *queryRecords(
    table: TableMetadata,
    columns: string[],
    opts: ReadOptions,
  ): AsyncGenerator<DvRecord[]> {
    const { list, attrs } = selectList(table, columns, pgQuoteIdent);
    const pk = pgQuoteIdent(table.primaryIdAttribute);
    const pageSize = Math.max(1, Math.min(opts.pageSize, 5000));
    const since = opts.since ? watermarkColumn(table, opts.since.field) : null;
    let last: FieldValue = null;
    for (;;) {
      // Keyset pagination: ordered by the primary key, continuing after the last one seen, so the
      // cost does not grow with the offset and a large table is never materialized.
      const where = [
        since ? `${pgQuoteIdent(since)} > @since` : '',
        last === null ? '' : `${pk} > @afterKey`,
      ].filter(Boolean);
      const text = `SELECT ${list} FROM ${pgQuoteTable(table.logicalName)}${
        where.length ? ` WHERE ${where.join(' AND ')}` : ''
      } ORDER BY ${pk} LIMIT ${pageSize}`;
      const rows = await this.query<Record<string, unknown>>(
        text,
        {
          ...(last === null ? {} : { afterKey: last }),
          ...(since ? { since: opts.since!.value } : {}),
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
    const { list, attrs } = selectList(table, columns, pgQuoteIdent);
    const pkAttr = table.attributes.find((a) => a.logicalName === table.primaryIdAttribute);
    // `= ANY(array)` is one parameter however many ids there are, so there is no chunking and no
    // parameter limit to stay under.
    const cast = numericKey(pkAttr) ? '::numeric[]' : '::text[]';
    const rows = await this.query<Record<string, unknown>>(
      `SELECT ${list} FROM ${pgQuoteTable(table.logicalName)} WHERE ${pgQuoteIdent(
        table.primaryIdAttribute,
      )} = ANY(@ids${cast})`,
      { ids: `{${ids.map((id) => `"${String(id).replace(/"/g, '\\"')}"`).join(',')}}` },
      `read ${table.logicalName} by id`,
    );
    return rows.map((r) => toRecord(table, r, attrs));
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
    const { list, attrs } = selectList(table, columns, pgQuoteIdent);
    const params: Record<string, FieldValue> = {};
    const predicates: string[] = [];
    for (const [name, value] of Object.entries(criteria)) {
      const column = pgQuoteIdent(name);
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
      `SELECT ${list} FROM ${pgQuoteTable(table.logicalName)} WHERE ${predicates.join(
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

  async createRecord(table: TableMetadata, record: WriteRecord, _options: WriteOptions): Promise<string> {
    const pkAttr = table.attributes.find((a) => a.logicalName === table.primaryIdAttribute);
    const { columns, params } = writableValues(table, record, true);
    const insertColumns = [...columns];
    // A key the server does not generate has to come from somewhere, so a supplied one is used.
    if (record.id && pkAttr && !pkAttr.sql?.isIdentity && !columns.includes(table.primaryIdAttribute)) {
      insertColumns.push(table.primaryIdAttribute);
      params[`c${insertColumns.length - 1}`] = record.id;
    }
    if (insertColumns.length === 0) {
      throw new DataverseError('VALIDATION', 'No writable columns were supplied.', 400, 'NO_COLUMNS');
    }
    const [row] = await this.query<{ insertedId: unknown }>(
      `INSERT INTO ${pgQuoteTable(table.logicalName)} (${insertColumns.map(pgQuoteIdent).join(', ')})
       VALUES (${insertColumns.map((_c, i) => `@c${i}`).join(', ')})
       RETURNING ${pgQuoteIdent(table.primaryIdAttribute)} AS "insertedId"`,
      params,
      `insert into ${table.logicalName}`,
    );
    if (row?.insertedId === undefined || row.insertedId === null) {
      throw new DataverseError(
        'SERVER_ERROR',
        `The insert into ${table.logicalName} did not return a key.`,
        500,
      );
    }
    return String(row.insertedId);
  }

  async updateRecord(
    table: TableMetadata,
    id: string,
    record: WriteRecord,
    _options: WriteOptions,
  ): Promise<void> {
    const { columns, params } = writableValues(table, record, false);
    if (columns.length === 0) return;
    const assignments = columns.map((c, i) => `${pgQuoteIdent(c)} = @c${i}`).join(', ');
    params.recordKey = id;
    const rows = await this.query<{ affected: number }>(
      `UPDATE ${pgQuoteTable(table.logicalName)} SET ${assignments}
       WHERE ${pgQuoteIdent(table.primaryIdAttribute)} = @recordKey
       RETURNING 1 AS "affected"`,
      params,
      `update ${table.logicalName}`,
    );
    if (rows.length === 0) {
      throw new DataverseError(
        'NOT_FOUND',
        `No row in ${table.logicalName} has ${table.primaryIdAttribute} = ${id}.`,
        404,
      );
    }
    if (rows.length > 1) {
      // The key is meant to identify one row. More than one means the metadata is wrong about it,
      // and the safe response is to say so rather than to have updated several.
      throw new DataverseError(
        'VALIDATION',
        `${rows.length} rows in ${table.logicalName} share ${table.primaryIdAttribute} = ${id}.`,
        400,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Dataverse-only surface
  // ---------------------------------------------------------------------------

  async whoAmI(): Promise<WhoAmI> {
    const [row] = await this.query<{ login: string; db: string }>(
      PG_WHOAMI_QUERY,
      {},
      'read the current login',
    );
    return { userId: row?.login ?? 'unknown', businessUnitId: row?.db ?? '', organizationId: row?.db ?? '' };
  }

  async detectAutomation(): Promise<AutomationInfo[]> {
    // Triggers and rules exist, but they are not the plug-in/flow model this reports, and guessing
    // an equivalence would be worse than reporting nothing.
    return [];
  }

  async listPrincipals(): Promise<PrincipalDto[]> {
    throw unsupportedOperation('listPrincipals', 'PostgreSQL');
  }

  async checkImpersonation(): Promise<{ allowed: boolean; message: string }> {
    return { allowed: false, message: 'PostgreSQL connections do not impersonate users.' };
  }
}

const withPublicSchema = (logicalName: string) =>
  logicalName.includes('.') ? logicalName : `public.${logicalName}`;

/** Whether a key column holds numbers, so an id array is cast to the right element type. */
const numericKey = (attr: AttributeMeta | undefined) =>
  attr?.type === 'Integer' || attr?.type === 'BigInt' || attr?.type === 'Decimal';

/** Re-exported so tests can exercise the normalization without a server. */
export { fromSql as pgFromSql, PG_TYPES };
