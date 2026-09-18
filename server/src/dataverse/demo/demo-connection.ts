import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { AutomationInfo, PrincipalDto, PrincipalTable } from '../../../../shared/domain';
import {
  LOOKUP_TYPES,
  isLookupValue,
  type AlternateKeyMeta,
  type DvRecord,
  type FieldValue,
  type TableMetadata,
  type TableSummary,
} from '../../../../shared/metadata';
import type { AppDb } from '../../db/client';
import { demoRecords } from '../../db/schema';
import { DataverseError } from '../errors';
import { sleep, withRetry, type RetryPolicy } from '../retry';
import type {
  ConnectionTestResult,
  DataverseConnection,
  RecordCount,
  WhoAmI,
  WriteOptions,
  WriteRecord,
} from '../types';
import { DATAVERSE_CAPABILITIES } from '../types';
import {
  DEMO_ORGANIZATION_ID,
  DEMO_SIGNED_IN_USER,
  demoUserId,
  demoAutomation,
  demoGuid,
  demoMetadata,
  type DemoEnvironmentDef,
} from './fixtures';

const DEMO_RETRY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000 };
/** Every Nth write attempt per environment is throttled (HTTP 429) to exercise backoff. */
const THROTTLE_EVERY = 97;
const writeCounters = new Map<string, number>();

/**
 * Simulated Dataverse environment for DEMO MODE. Records are persisted in the application
 * database, and writes are validated against the environment's metadata the way Dataverse
 * would (unknown/read-only columns, max length, choice values, missing references,
 * duplicate keys), so migration outcomes are genuinely computed, never scripted.
 */
export class DemoConnection implements DataverseConnection {
  readonly provider = 'demo' as const;
  readonly url: string;
  readonly capabilities = DATAVERSE_CAPABILITIES;
  private readonly tables: Map<string, TableMetadata>;

  constructor(
    private readonly env: DemoEnvironmentDef,
    private readonly db: AppDb,
    private readonly logger: Logger,
    private readonly latencyMs: number,
  ) {
    this.url = env.url;
    this.tables = new Map(demoMetadata(env.key).map((t) => [t.logicalName, t]));
  }

  private async simulate(factor = 1) {
    if (this.env.connectionError) {
      throw new DataverseError('FORBIDDEN', this.env.connectionError, 403, '0x80072560');
    }
    if (this.latencyMs > 0) await sleep(this.latencyMs * factor);
  }

  private table(logicalName: string): TableMetadata {
    const t = this.tables.get(logicalName);
    if (!t)
      throw new DataverseError(
        'NOT_FOUND',
        `Entity '${logicalName}' was not found in the MetadataCache.`,
        404,
        '0x80060888',
      );
    return t;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const who = await this.whoAmI();
    const tables = await this.listTables();
    return {
      ok: true,
      summary: `Simulated Dataverse environment ${this.env.displayName}`,
      checks: [
        { key: 'network', label: 'Environment reachable', status: 'PASS', message: this.url },
        { key: 'auth', label: 'Authentication', status: 'PASS', message: `Connected as ${who.userId}` },
        {
          key: 'read',
          label: 'Read permission',
          status: 'PASS',
          message: `${tables.length} tables readable`,
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

  async whoAmI(): Promise<WhoAmI> {
    await this.simulate();
    return {
      userId: demoUserId(this.env.key, DEMO_SIGNED_IN_USER),
      businessUnitId: demoGuid('businessunit', 'root'),
      organizationId: demoGuid(DEMO_ORGANIZATION_ID, this.env.key),
    };
  }

  async listTables(): Promise<TableSummary[]> {
    await this.simulate(3);
    return [...this.tables.values()].map(
      ({ attributes: _a, manyToOne: _m, manyToMany: _mm, keys: _k, ...summary }) => summary,
    );
  }

  async getTable(logicalName: string): Promise<TableMetadata> {
    await this.simulate(2);
    return structuredClone(this.table(logicalName));
  }

  async countRecords(t: TableSummary): Promise<RecordCount> {
    await this.simulate();
    this.table(t.logicalName);
    const [row] = await this.db
      .select({ n: count() })
      .from(demoRecords)
      .where(and(eq(demoRecords.environmentKey, this.env.key), eq(demoRecords.logicalName, t.logicalName)));
    return { count: Number(row?.n ?? 0), approximate: false };
  }

  private project(t: TableMetadata, data: Record<string, unknown>, columns: string[]): DvRecord {
    const values: Record<string, FieldValue> = {};
    for (const c of columns) {
      if (c === t.primaryIdAttribute) continue;
      values[c] = (data[c] as FieldValue | undefined) ?? null;
    }
    return { id: String(data[t.primaryIdAttribute]), values };
  }

  async *queryRecords(
    t: TableMetadata,
    columns: string[],
    opts: { pageSize: number },
  ): AsyncGenerator<DvRecord[]> {
    this.table(t.logicalName);
    let offset = 0;
    for (;;) {
      await this.simulate();
      const rows = await this.db
        .select()
        .from(demoRecords)
        .where(and(eq(demoRecords.environmentKey, this.env.key), eq(demoRecords.logicalName, t.logicalName)))
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
          eq(demoRecords.environmentKey, this.env.key),
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
    await this.simulate();
    const target = this.table(t.logicalName);
    if (!target.keys.some((k) => k.logicalName === key.logicalName)) {
      throw new DataverseError(
        'VALIDATION',
        `Alternate key ${key.logicalName} is not defined for ${t.logicalName}`,
        400,
      );
    }
    const match = await this.findKeyMatch(target, key, values);
    return match ? this.project(target, match, columns) : null;
  }

  private async findKeyMatch(
    t: TableMetadata,
    key: AlternateKeyMeta,
    values: Record<string, FieldValue>,
    excludeId?: string,
  ) {
    const conditions = key.attributes.map((a) => {
      const v = values[a];
      if (v === null || v === undefined) return null;
      const scalar = isLookupValue(v) ? v.id : String(v);
      return sql`coalesce(${demoRecords.data}->${a}->>'id', ${demoRecords.data}->>${a}) = ${scalar}`;
    });
    if (conditions.some((c) => c === null)) return null;
    const rows = await this.db
      .select()
      .from(demoRecords)
      .where(
        and(
          eq(demoRecords.environmentKey, this.env.key),
          eq(demoRecords.logicalName, t.logicalName),
          ...(conditions as never[]),
        ),
      )
      .limit(2);
    return rows.find((r) => r.recordId !== excludeId)?.data ?? null;
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
          eq(demoRecords.environmentKey, this.env.key),
          eq(demoRecords.logicalName, t.logicalName),
          ...(conditions as never[]),
        ),
      )
      .limit(Math.max(1, Math.min(limit, 50)));
    return rows.map((r) => this.project(t, r.data, columns));
  }

  // ---------------------------------------------------------------------------
  // Writes (validated like Dataverse)
  // ---------------------------------------------------------------------------

  private async validateValues(t: TableMetadata, values: Record<string, FieldValue>, forCreate: boolean) {
    const attrs = new Map(t.attributes.map((a) => [a.logicalName, a]));
    for (const [name, value] of Object.entries(values)) {
      const a = attrs.get(name);
      if (!a || a.attributeOf) {
        throw new DataverseError(
          'VALIDATION',
          `Invalid property '${name}' was found in entity 'Microsoft.Dynamics.CRM.${t.logicalName}'.`,
          400,
          '0x80060891',
        );
      }
      if (forCreate ? !a.isValidForCreate : !a.isValidForUpdate) {
        throw new DataverseError(
          'VALIDATION',
          `Attribute '${name}' of entity '${t.logicalName}' is not valid for ${forCreate ? 'create' : 'update'}.`,
          400,
          '0x80048d19',
        );
      }
      if (value === null) continue;
      const invalid = (expected: string) =>
        new DataverseError(
          'VALIDATION',
          `Cannot convert the literal '${String(value)}' to the expected type '${expected}' for '${name}'.`,
          400,
          '0x80048d19',
        );
      switch (a.type) {
        case 'String':
        case 'Memo':
          if (typeof value !== 'string') throw invalid('Edm.String');
          if (a.maxLength != null && value.length > a.maxLength) {
            throw new DataverseError(
              'VALIDATION',
              `A validation error occurred. The length of the '${name}' attribute of the '${t.logicalName}' entity exceeded the maximum allowed length of '${a.maxLength}'.`,
              400,
              '0x80044331',
            );
          }
          break;
        case 'Integer':
        case 'BigInt':
          if (typeof value !== 'number' || !Number.isInteger(value)) throw invalid('Edm.Int32');
          break;
        case 'Decimal':
        case 'Double':
        case 'Money':
          if (typeof value !== 'number') throw invalid('Edm.Decimal');
          break;
        case 'Boolean':
          if (typeof value !== 'boolean') throw invalid('Edm.Boolean');
          break;
        case 'DateTime':
          if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
            throw invalid('Edm.DateTimeOffset');
          break;
        case 'Picklist':
        case 'State':
        case 'Status':
          if (typeof value !== 'number') throw invalid('Edm.Int32');
          if (a.options && !a.options.some((o) => o.value === value)) {
            throw new DataverseError(
              'VALIDATION',
              `${name} value ${value} is not a valid value for this choice column.`,
              400,
              '0x8004431a',
            );
          }
          break;
        case 'Lookup':
        case 'Customer':
        case 'Owner': {
          if (!isLookupValue(value)) throw invalid('Microsoft.Dynamics.CRM.EntityReference');
          if (!a.targets?.includes(value.logicalName)) {
            throw new DataverseError(
              'VALIDATION',
              `${name} cannot reference entity ${value.logicalName}.`,
              400,
              '0x80048d19',
            );
          }
          const [exists] = await this.db
            .select({ id: demoRecords.recordId })
            .from(demoRecords)
            .where(
              and(
                eq(demoRecords.environmentKey, this.env.key),
                eq(demoRecords.logicalName, value.logicalName),
                eq(demoRecords.recordId, value.id.toLowerCase()),
              ),
            );
          if (!exists) {
            throw new DataverseError(
              'REFERENCE_NOT_FOUND',
              `${value.logicalName} With Id = ${value.id} Does Not Exist`,
              404,
              '0x80040217',
            );
          }
          break;
        }
        default:
          break;
      }
    }
  }

  private async write<T>(operation: () => Promise<T>, context: Record<string, unknown>): Promise<T> {
    return withRetry(
      async () => {
        await this.simulate();
        const n = (writeCounters.get(this.env.key) ?? 0) + 1;
        writeCounters.set(this.env.key, n);
        if (n % THROTTLE_EVERY === 0) {
          throw new DataverseError(
            'THROTTLED',
            'Number of requests exceeded the limit of 8000 over time window of 300 seconds.',
            429,
            '0x80072322',
          );
        }
        return operation();
      },
      { policy: DEMO_RETRY, logger: this.logger, context: { ...context, dataverseUrl: this.url } },
    );
  }

  private computed(t: TableMetadata, data: Record<string, unknown>) {
    if (t.logicalName === 'contact') {
      data.fullname = [data.firstname, data.lastname].filter(Boolean).join(' ') || null;
    }
  }

  async createRecord(tableMeta: TableMetadata, record: WriteRecord, options: WriteOptions): Promise<string> {
    const t = this.table(tableMeta.logicalName);
    return this.write(
      async () => {
        this.assertBypassAllowed(options);
        await this.validateValues(t, record.values, true);
        const id = (record.id ?? crypto.randomUUID()).toLowerCase();
        for (const a of t.attributes) {
          if (
            a.requiredLevel === 'SystemRequired' &&
            a.isValidForCreate &&
            !LOOKUP_TYPES.has(a.type) &&
            a.type !== 'State' &&
            !a.isPrimaryId
          ) {
            const v = record.values[a.logicalName];
            if (v === null || v === undefined || v === '') {
              throw new DataverseError(
                'VALIDATION',
                `Required field '${a.logicalName}' is missing.`,
                400,
                '0x80040203',
              );
            }
          }
        }
        for (const k of t.keys) {
          if (await this.findKeyMatch(t, k, record.values)) {
            throw new DataverseError(
              'DUPLICATE_RECORD',
              `A record that has the attribute values ${k.attributes.map((x) => `${x}=${String(record.values[x])}`).join(', ')} already exists. The entity key ${k.logicalName} requires that this set of attributes contains unique values.`,
              412,
              '0x80060892',
            );
          }
        }
        const now = new Date().toISOString();
        // The caller is the impersonated user when one is supplied (MSCRMCallerID), exactly
        // like Dataverse: createdby/modifiedby follow the caller, modifiedon never does.
        const caller = {
          id: (options.impersonateUserId ?? demoUserId(this.env.key, DEMO_SIGNED_IN_USER)).toLowerCase(),
          logicalName: 'systemuser',
        };
        const backdated = record.values.overriddencreatedon;
        const data: Record<string, unknown> = {
          ...record.values,
          [t.primaryIdAttribute]: id,
          createdon: typeof backdated === 'string' ? backdated : now,
          modifiedon: now,
          createdby: caller,
          modifiedby: caller,
          // Ownership defaults to the caller unless the write supplies an owner.
          ownerid: record.values.ownerid ?? caller,
          statecode: record.values.statecode ?? 0,
        };
        delete data.overriddencreatedon;
        this.computed(t, data);
        const inserted = await this.db
          .insert(demoRecords)
          .values({ environmentKey: this.env.key, logicalName: t.logicalName, recordId: id, data })
          .onConflictDoNothing()
          .returning({ id: demoRecords.recordId });
        if (inserted.length === 0) {
          throw new DataverseError('DUPLICATE_RECORD', 'Cannot insert duplicate key.', 412, '0x80040237');
        }
        return id;
      },
      { operation: 'create', table: t.logicalName },
    );
  }

  async updateRecord(
    tableMeta: TableMetadata,
    id: string,
    record: WriteRecord,
    options: WriteOptions,
  ): Promise<void> {
    const t = this.table(tableMeta.logicalName);
    await this.write(
      async () => {
        this.assertBypassAllowed(options);
        await this.validateValues(t, record.values, false);
        const recordId = id.toLowerCase();
        const [existing] = await this.db
          .select()
          .from(demoRecords)
          .where(
            and(
              eq(demoRecords.environmentKey, this.env.key),
              eq(demoRecords.logicalName, t.logicalName),
              eq(demoRecords.recordId, recordId),
            ),
          );
        if (!existing) {
          throw new DataverseError(
            'NOT_FOUND',
            `${t.logicalName} With Id = ${id} Does Not Exist`,
            404,
            '0x80040217',
          );
        }
        for (const k of t.keys) {
          const merged = { ...(existing.data as Record<string, FieldValue>), ...record.values };
          if (await this.findKeyMatch(t, k, merged, recordId)) {
            throw new DataverseError(
              'DUPLICATE_RECORD',
              `Entity key ${k.logicalName} violation.`,
              412,
              '0x80060892',
            );
          }
        }
        const caller = {
          id: (options.impersonateUserId ?? demoUserId(this.env.key, DEMO_SIGNED_IN_USER)).toLowerCase(),
          logicalName: 'systemuser',
        };
        const data = {
          ...existing.data,
          ...record.values,
          modifiedon: new Date().toISOString(),
          modifiedby: caller,
        };
        this.computed(t, data);
        await this.db
          .update(demoRecords)
          .set({ data, updatedAt: new Date() })
          .where(
            and(
              eq(demoRecords.environmentKey, this.env.key),
              eq(demoRecords.logicalName, t.logicalName),
              eq(demoRecords.recordId, recordId),
            ),
          );
      },
      { operation: 'update', table: t.logicalName },
    );
  }

  private assertBypassAllowed(options: WriteOptions) {
    // The demo user does not hold prvBypassCustomBusinessLogic, mirroring a least-privilege account.
    if (options.bypassCustomBusinessLogic) {
      throw new DataverseError(
        'FORBIDDEN',
        'Principal user is missing prvBypassCustomBusinessLogic privilege.',
        403,
        '0x80040220',
      );
    }
  }

  async listPrincipals(table: PrincipalTable): Promise<PrincipalDto[]> {
    await this.simulate();
    const rows = await this.db
      .select()
      .from(demoRecords)
      .where(and(eq(demoRecords.environmentKey, this.env.key), eq(demoRecords.logicalName, table)));
    return rows
      .map((r) => {
        const d = r.data as Record<string, string | boolean | null>;
        return {
          id: r.recordId,
          name: String(d.fullname ?? d.name ?? '(unnamed)'),
          login: (d.domainname as string) ?? null,
          email: (d.internalemailaddress as string) ?? (d.emailaddress as string) ?? null,
          entraObjectId: (d.azureactivedirectoryobjectid as string) ?? null,
          disabled: Boolean(d.isdisabled),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async checkImpersonation(targetUserId: string): Promise<{ allowed: boolean; message: string }> {
    await this.simulate();
    const [user] = await this.db
      .select({ id: demoRecords.recordId })
      .from(demoRecords)
      .where(
        and(
          eq(demoRecords.environmentKey, this.env.key),
          eq(demoRecords.logicalName, 'systemuser'),
          eq(demoRecords.recordId, targetUserId.toLowerCase()),
        ),
      );
    return user
      ? { allowed: true, message: 'The demo user may act on behalf of other users in this environment' }
      : { allowed: false, message: `User ${targetUserId} does not exist in this environment` };
  }

  async detectAutomation(tables: TableSummary[]): Promise<AutomationInfo[]> {
    await this.simulate();
    return tables.map((t) => demoAutomation(this.env.key, t.logicalName));
  }
}
