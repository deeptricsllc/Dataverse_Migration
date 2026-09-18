import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { AutomationInfo, PrincipalDto } from '../../../../shared/domain';
import {
  isLookupValue,
  type AlternateKeyMeta,
  type DvRecord,
  type FieldValue,
  type TableMetadata,
  type TableSummary,
} from '../../../../shared/metadata';
import type { AppDb } from '../../db/client';
import { demoRecords } from '../../db/schema';
import { DataverseError } from '../../dataverse/errors';
import { sleep } from '../../dataverse/retry';
import { unsupportedOperation } from '../errors';
import type {
  ConnectionTestResult,
  MigrationConnector,
  RecordCount,
  WhoAmI,
  WriteOptions,
  WriteRecord,
} from '../types';
import { SQL_CAPABILITIES } from '../types';
import { DEMO_SQL_ENVIRONMENT, DEMO_SQL_URL, demoSqlTables } from './demo-fixtures';

/**
 * A simulated SQL Server for DEMO MODE. It stores rows in the same table as the simulated
 * Dataverse environments but behaves like SQL: identity columns are server-generated, foreign
 * keys are plain scalars that this connector surfaces as lookups (so the shared migration engine
 * resolves them through the record identity map exactly as it does for Dataverse), and writes are
 * checked against nullability, length and foreign-key existence the way a database would.
 */
export class DemoSqlConnection implements MigrationConnector {
  readonly provider = 'demosql' as const;
  readonly url = DEMO_SQL_URL;
  readonly capabilities = SQL_CAPABILITIES;
  private readonly tables: Map<string, TableMetadata>;

  constructor(
    private readonly envKey: string,
    private readonly db: AppDb,
    private readonly logger: Logger,
    private readonly latencyMs: number,
  ) {
    this.tables = new Map(demoSqlTables().map((t) => [t.logicalName, t]));
  }

  private async simulate(factor = 1) {
    if (this.latencyMs > 0) await sleep(this.latencyMs * factor);
  }

  private table(logicalName: string): TableMetadata {
    const t = this.tables.get(logicalName);
    if (!t) {
      throw new DataverseError(
        'NOT_FOUND',
        `Invalid object name '${logicalName}'.`,
        404,
        '208', // SQL Server error 208
      );
    }
    return t;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    await this.simulate();
    return {
      ok: true,
      summary: `${DEMO_SQL_ENVIRONMENT.version} — simulated database ${DEMO_SQL_ENVIRONMENT.database}`,
      checks: [
        { key: 'network', label: 'Server reachable', status: 'PASS', message: 'Simulated server' },
        { key: 'auth', label: 'Authentication', status: 'PASS', message: 'Simulated SQL login' },
        {
          key: 'database',
          label: 'Database accessible',
          status: 'PASS',
          message: `${DEMO_SQL_ENVIRONMENT.database} (simulated)`,
        },
        {
          key: 'read',
          label: 'Read permission',
          status: 'PASS',
          message: `${this.tables.size} tables readable`,
        },
        {
          key: 'write',
          label: 'Write permission',
          status: 'NOT_TESTED',
          message: 'Never probed; a connection test never writes data',
        },
      ],
    };
  }

  async listTables(): Promise<TableSummary[]> {
    await this.simulate(2);
    return [...this.tables.values()].map(
      ({ attributes: _a, manyToOne: _m, manyToMany: _mm, keys: _k, ...summary }) => summary,
    );
  }

  async getTable(logicalName: string): Promise<TableMetadata> {
    await this.simulate();
    return structuredClone(this.table(logicalName));
  }

  async countRecords(t: TableSummary): Promise<RecordCount> {
    await this.simulate();
    this.table(t.logicalName);
    const [row] = await this.db
      .select({ n: count() })
      .from(demoRecords)
      .where(and(eq(demoRecords.environmentKey, this.envKey), eq(demoRecords.logicalName, t.logicalName)));
    return { count: Number(row?.n ?? 0), approximate: false };
  }

  /**
   * Turns a stored row into the normalized record shape. Foreign-key columns become LookupValue
   * so that every downstream service (dependency ordering, identity map, lookup resolution)
   * treats a SQL relationship exactly like a Dataverse one.
   */
  private project(t: TableMetadata, data: Record<string, unknown>, columns: string[]): DvRecord {
    const attrs = new Map(t.attributes.map((a) => [a.logicalName, a]));
    const values: Record<string, FieldValue> = {};
    for (const c of columns) {
      if (c === t.primaryIdAttribute) continue;
      const raw = data[c] ?? null;
      const attr = attrs.get(c);
      if (attr?.type === 'Lookup' && raw !== null && !isLookupValue(raw)) {
        values[c] = { id: String(raw), logicalName: attr.targets![0] };
      } else {
        values[c] = raw as FieldValue;
      }
    }
    return { id: String(data[t.primaryIdAttribute]), values };
  }

  async *queryRecords(
    t: TableMetadata,
    columns: string[],
    opts: { pageSize: number },
  ): AsyncGenerator<DvRecord[]> {
    this.table(t.logicalName);
    // Keyset-style paging over the stored rows: a page at a time, never the whole table.
    let offset = 0;
    for (;;) {
      await this.simulate();
      const rows = await this.db
        .select()
        .from(demoRecords)
        .where(and(eq(demoRecords.environmentKey, this.envKey), eq(demoRecords.logicalName, t.logicalName)))
        .orderBy(asc(demoRecords.recordId))
        .limit(opts.pageSize)
        .offset(offset);
      if (rows.length === 0) return;
      yield rows.map((r) => this.project(t, r.data, columns));
      if (rows.length < opts.pageSize) return;
      offset += rows.length;
    }
  }

  async retrieveByIds(t: TableMetadata, ids: string[], columns: string[]): Promise<DvRecord[]> {
    await this.simulate();
    this.table(t.logicalName);
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(demoRecords)
      .where(
        and(
          eq(demoRecords.environmentKey, this.envKey),
          eq(demoRecords.logicalName, t.logicalName),
          inArray(
            demoRecords.recordId,
            ids.map((i) => i.toLowerCase()),
          ),
        ),
      );
    return rows.map((r) => this.project(t, r.data, columns));
  }

  async findByAlternateKey(
    t: TableMetadata,
    key: AlternateKeyMeta,
    values: Record<string, FieldValue>,
    columns: string[],
  ): Promise<DvRecord | null> {
    const found = await this.findByFields(
      t,
      Object.fromEntries(key.attributes.map((a) => [a, values[a] ?? null])),
      columns,
      2,
    );
    return found[0] ?? null;
  }

  async findByFields(
    tableMeta: TableMetadata,
    criteria: Record<string, FieldValue>,
    columns: string[],
    limit: number,
  ): Promise<DvRecord[]> {
    await this.simulate();
    const t = this.table(tableMeta.logicalName);
    const conditions = Object.entries(criteria).map(([field, value]) => {
      const scalar = isLookupValue(value) ? value.id : value === null ? null : String(value);
      return scalar === null
        ? sql`coalesce(${demoRecords.data}->${field}->>'id', ${demoRecords.data}->>${field}) is null`
        : sql`coalesce(${demoRecords.data}->${field}->>'id', ${demoRecords.data}->>${field}) = ${scalar}`;
    });
    const rows = await this.db
      .select()
      .from(demoRecords)
      .where(
        and(
          eq(demoRecords.environmentKey, this.envKey),
          eq(demoRecords.logicalName, t.logicalName),
          ...(conditions as never[]),
        ),
      )
      .limit(Math.max(1, Math.min(limit, 50)));
    return rows.map((r) => this.project(t, r.data, columns));
  }

  // ---------------------------------------------------------------------------
  // Writes, validated the way a database would
  // ---------------------------------------------------------------------------

  private sqlError(message: string, code: string) {
    return new DataverseError('VALIDATION', message, 400, code, undefined, false);
  }

  private async toStoredValues(
    t: TableMetadata,
    values: Record<string, FieldValue>,
    forCreate: boolean,
  ): Promise<Record<string, unknown>> {
    const attrs = new Map(t.attributes.map((a) => [a.logicalName, a]));
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(values)) {
      const a = attrs.get(name);
      if (!a) throw this.sqlError(`Invalid column name '${name}'.`, '207');
      if (forCreate ? !a.isValidForCreate : !a.isValidForUpdate) {
        if (a.sql?.isIdentity) {
          throw this.sqlError(
            `Cannot insert explicit value for identity column in table '${t.schemaName}' when IDENTITY_INSERT is set to OFF.`,
            '544',
          );
        }
        throw this.sqlError(`The column "${name}" cannot be modified.`, '271');
      }
      if (value === null) {
        if (a.sql && !a.sql.isNullable && !a.sql.defaultDefinition) {
          throw this.sqlError(
            `Cannot insert the value NULL into column '${name}', table '${t.logicalName}'; column does not allow nulls.`,
            '515',
          );
        }
        out[name] = null;
        continue;
      }
      if ((a.type === 'String' || a.type === 'Memo') && typeof value === 'string') {
        const max = a.maxLength ?? null;
        if (max !== null && max > 0 && value.length > max) {
          throw this.sqlError(
            `String or binary data would be truncated in table '${t.logicalName}', column '${name}'. Truncated value: '${value.slice(0, 20)}...'.`,
            '2628',
          );
        }
      }
      if (a.type === 'Lookup') {
        // A foreign key stores the referenced row's key, and the row must exist.
        const scalar = isLookupValue(value) ? value.id : String(value);
        const referenced = a.targets![0];
        const [exists] = await this.db
          .select({ n: count() })
          .from(demoRecords)
          .where(
            and(
              eq(demoRecords.environmentKey, this.envKey),
              eq(demoRecords.logicalName, referenced),
              eq(demoRecords.recordId, scalar.toLowerCase()),
            ),
          );
        if (Number(exists?.n ?? 0) === 0) {
          throw this.sqlError(
            `The INSERT statement conflicted with the FOREIGN KEY constraint "FK_${t.schemaName}_${name}". The conflict occurred in table "${referenced}".`,
            '547',
          );
        }
        out[name] = /^\d+$/.test(scalar) ? Number(scalar) : scalar;
        continue;
      }
      out[name] = value;
    }
    return out;
  }

  async createRecord(t: TableMetadata, record: WriteRecord, _options: WriteOptions): Promise<string> {
    await this.simulate();
    const table = this.table(t.logicalName);
    const pk = table.attributes.find((a) => a.logicalName === table.primaryIdAttribute)!;
    const values = await this.toStoredValues(table, record.values, true);

    // An identity primary key is generated by the server; a natural key comes from the caller.
    let id: string;
    if (pk.sql?.isIdentity) {
      const [row] = await this.db
        .select({ n: count() })
        .from(demoRecords)
        .where(
          and(eq(demoRecords.environmentKey, this.envKey), eq(demoRecords.logicalName, table.logicalName)),
        );
      id = String(Number(row?.n ?? 0) + 1 + 1000); // offset so demo ids never collide with seeds
      values[pk.logicalName] = Number(id);
    } else {
      const supplied = record.id ?? (record.values[pk.logicalName] as string | undefined);
      if (!supplied) {
        throw this.sqlError(
          `Cannot insert the value NULL into column '${pk.logicalName}', table '${table.logicalName}'; column does not allow nulls.`,
          '515',
        );
      }
      id = String(supplied);
      values[pk.logicalName] = id;
    }

    const existing = await this.db
      .select({ id: demoRecords.recordId })
      .from(demoRecords)
      .where(
        and(
          eq(demoRecords.environmentKey, this.envKey),
          eq(demoRecords.logicalName, table.logicalName),
          eq(demoRecords.recordId, id.toLowerCase()),
        ),
      );
    if (existing.length) {
      throw this.sqlError(
        `Violation of PRIMARY KEY constraint 'PK_${table.schemaName}'. Cannot insert duplicate key in object '${table.logicalName}'.`,
        '2627',
      );
    }
    await this.assertUniqueKeys(table, values, null);
    await this.db.insert(demoRecords).values({
      environmentKey: this.envKey,
      logicalName: table.logicalName,
      recordId: id.toLowerCase(),
      data: values as Record<string, never>,
    });
    return id;
  }

  async updateRecord(
    t: TableMetadata,
    id: string,
    record: WriteRecord,
    _options: WriteOptions,
  ): Promise<void> {
    await this.simulate();
    const table = this.table(t.logicalName);
    const [existing] = await this.db
      .select()
      .from(demoRecords)
      .where(
        and(
          eq(demoRecords.environmentKey, this.envKey),
          eq(demoRecords.logicalName, table.logicalName),
          eq(demoRecords.recordId, id.toLowerCase()),
        ),
      );
    // A deterministic WHERE on the primary key: an update that matches nothing is an error,
    // never a silent no-op and never a write that touches more than one row.
    if (!existing) {
      throw new DataverseError(
        'NOT_FOUND',
        `No row with ${table.primaryIdAttribute} = ${id} exists in ${table.logicalName}`,
        404,
      );
    }
    const values = await this.toStoredValues(table, record.values, false);
    await this.assertUniqueKeys(table, { ...existing.data, ...values }, id.toLowerCase());
    await this.db
      .update(demoRecords)
      .set({ data: { ...existing.data, ...values } as Record<string, never> })
      .where(
        and(
          eq(demoRecords.environmentKey, this.envKey),
          eq(demoRecords.logicalName, table.logicalName),
          eq(demoRecords.recordId, id.toLowerCase()),
        ),
      );
  }

  private async assertUniqueKeys(
    t: TableMetadata,
    values: Record<string, unknown>,
    excludeId: string | null,
  ) {
    for (const key of t.keys) {
      if (key.attributes.includes(t.primaryIdAttribute)) continue;
      if (key.attributes.some((a) => values[a] === undefined || values[a] === null)) continue;
      const rows = await this.findByFields(
        t,
        Object.fromEntries(key.attributes.map((a) => [a, values[a] as FieldValue])),
        [],
        2,
      );
      if (rows.some((r) => r.id.toLowerCase() !== excludeId)) {
        throw this.sqlError(
          `Violation of UNIQUE KEY constraint '${key.logicalName}'. Cannot insert duplicate key in object '${t.logicalName}'.`,
          '2627',
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Not applicable to a relational database
  // ---------------------------------------------------------------------------

  async whoAmI(): Promise<WhoAmI> {
    return { userId: 'iic_migration', businessUnitId: '', organizationId: DEMO_SQL_ENVIRONMENT.database };
  }

  async detectAutomation(): Promise<AutomationInfo[]> {
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
