import type { Logger } from 'pino';
import type { AutomationInfo, PrincipalDto, PrincipalTable } from '../../../shared/domain';
import {
  LOOKUP_TYPES,
  isLookupValue,
  type AlternateKeyMeta,
  type AttributeMeta,
  type DvRecord,
  type FieldValue,
  type TableMetadata,
  type TableSummary,
} from '../../../shared/metadata';
import { DataverseError, classifyHttpError, toDataverseError } from './errors';
import {
  normalizeAttribute,
  normalizeKey,
  normalizeManyToMany,
  normalizeManyToOne,
  normalizeRecord,
  normalizeTableSummary,
} from './normalize';
import { DEFAULT_RETRY_POLICY, Semaphore, withRetry, type RetryPolicy } from './retry';
import type { DataverseConnection, RecordCount, WhoAmI, WriteOptions, WriteRecord } from './types';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface WebApiOptions {
  url: string;
  apiVersion: string;
  getAccessToken: () => Promise<string>;
  logger: Logger;
  fetchImpl?: typeof fetch;
  retryPolicy?: RetryPolicy;
  maxConcurrency?: number;
  timeoutMs?: number;
  /** When true, every non-GET request is refused before it leaves this process. */
  readOnly?: boolean;
}

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE', 'MERGE']);

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Absolute URL (e.g. @odata.nextLink). */
  absolute?: boolean;
}

const TABLE_SELECT =
  'LogicalName,SchemaName,EntitySetName,DisplayName,Description,PrimaryIdAttribute,PrimaryNameAttribute,IsCustomEntity,OwnershipType,IsIntersect,IsActivity';
const ATTRIBUTE_SELECT =
  'LogicalName,SchemaName,AttributeType,AttributeTypeName,DisplayName,Description,RequiredLevel,IsPrimaryId,IsPrimaryName,IsCustomAttribute,IsValidForCreate,IsValidForUpdate,IsValidForRead,IsSecured,AttributeOf';

/** Type-specific attribute metadata requested via casts. */
const ATTRIBUTE_CASTS: { cast: string; query: string }[] = [
  { cast: 'StringAttributeMetadata', query: '$select=LogicalName,MaxLength,Format' },
  { cast: 'MemoAttributeMetadata', query: '$select=LogicalName,MaxLength' },
  { cast: 'IntegerAttributeMetadata', query: '$select=LogicalName,MinValue,MaxValue' },
  { cast: 'DecimalAttributeMetadata', query: '$select=LogicalName,Precision,MinValue,MaxValue' },
  { cast: 'DoubleAttributeMetadata', query: '$select=LogicalName,Precision,MinValue,MaxValue' },
  { cast: 'MoneyAttributeMetadata', query: '$select=LogicalName,Precision,MinValue,MaxValue' },
  { cast: 'DateTimeAttributeMetadata', query: '$select=LogicalName,Format,DateTimeBehavior' },
  { cast: 'LookupAttributeMetadata', query: '$select=LogicalName,Targets' },
  { cast: 'PicklistAttributeMetadata', query: '$select=LogicalName&$expand=OptionSet,GlobalOptionSet' },
  {
    cast: 'MultiSelectPicklistAttributeMetadata',
    query: '$select=LogicalName&$expand=OptionSet,GlobalOptionSet',
  },
  { cast: 'StateAttributeMetadata', query: '$select=LogicalName&$expand=OptionSet' },
  { cast: 'StatusAttributeMetadata', query: '$select=LogicalName&$expand=OptionSet' },
];

const odataString = (v: string) => `'${v.replace(/'/g, "''")}'`;
/**
 * Characters Dataverse rejects inside alternate-key URL segments; such values must be looked up
 * with $filter instead.
 * https://learn.microsoft.com/power-apps/developer/data-platform/use-alternate-key-reference-record
 */
const KEY_UNSUPPORTED_CHARS = /[/<>*%&:\\?+]/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Dataverse Web API client (delegated user token). Centralizes base URLs, headers, paging,
 * retries/throttling, concurrency limits and error mapping.
 */
export class WebApiConnection implements DataverseConnection {
  readonly provider = 'dataverse' as const;
  readonly url: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly semaphore: Semaphore;
  private catalog: Map<string, TableSummary> | null = null;

  constructor(private readonly opts: WebApiOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.baseUrl = `${this.url}/api/data/${opts.apiVersion}/`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.semaphore = new Semaphore(opts.maxConcurrency ?? 4);
  }

  // ---------------------------------------------------------------------------
  // HTTP core
  // ---------------------------------------------------------------------------

  async request<T = Raw>(
    method: string,
    pathOrUrl: string,
    options: RequestOptions = {},
  ): Promise<{ data: T; headers: Headers }> {
    const url = options.absolute ? pathOrUrl : this.baseUrl + pathOrUrl;
    // Read-only deployments refuse writes here, so no code path can reach Dataverse with a
    // mutating request, regardless of what the UI or a service tried to do.
    if (this.opts.readOnly && WRITE_METHODS.has(method.toUpperCase())) {
      throw new DataverseError(
        'READ_ONLY_MODE',
        `REAL_TENANT_READ_ONLY is enabled. Dataverse write operations are disabled for this deployment (attempted ${method.toUpperCase()} ${pathOrUrl.split('?')[0]}).`,
        403,
        undefined,
        undefined,
        false,
      );
    }
    const startedAt = Date.now();
    return withRetry(
      () =>
        this.semaphore.run(async () => {
          const token = await this.opts.getAccessToken();
          const headers: Record<string, string> = {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'OData-MaxVersion': '4.0',
            'OData-Version': '4.0',
            ...options.headers,
          };
          if (options.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
          let res: Response;
          try {
            res = await this.fetchImpl(url, {
              method,
              headers,
              body: options.body === undefined ? undefined : JSON.stringify(options.body),
              signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
            });
          } catch (err) {
            throw toDataverseError(err);
          }
          const text = await res.text();
          let data: unknown = undefined;
          if (text) {
            try {
              data = JSON.parse(text);
            } catch {
              data = { error: { message: text.slice(0, 500) } };
            }
          }
          if (!res.ok) throw classifyHttpError(res.status, data, res.headers.get('Retry-After'));
          return { data: data as T, headers: res.headers };
        }),
      {
        policy: this.opts.retryPolicy ?? DEFAULT_RETRY_POLICY,
        logger: this.opts.logger,
        context: {
          dataverseUrl: this.url,
          method,
          path: options.absolute ? '(nextLink)' : pathOrUrl.split('?')[0],
        },
      },
    ).finally(() => {
      this.opts.logger.debug(
        { method, path: pathOrUrl.split('?')[0], ms: Date.now() - startedAt },
        'dataverse request',
      );
    });
  }

  private async getAll<T = Raw>(path: string, headers?: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    let absolute = false;
    while (next) {
      const { data }: { data: Raw } = await this.request<Raw>('GET', next, { headers, absolute });
      out.push(...((data.value ?? []) as T[]));
      next = data['@odata.nextLink'];
      absolute = true;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------

  async whoAmI(): Promise<WhoAmI> {
    const { data } = await this.request<Raw>('GET', 'WhoAmI');
    return { userId: data.UserId, businessUnitId: data.BusinessUnitId, organizationId: data.OrganizationId };
  }

  async listTables(): Promise<TableSummary[]> {
    const rows = await this.getAll(`EntityDefinitions?$select=${TABLE_SELECT}`);
    const tables = rows
      .map(normalizeTableSummary)
      .filter((t) => t.entitySetName)
      .sort((a, b) => a.logicalName.localeCompare(b.logicalName));
    this.catalog = new Map(tables.map((t) => [t.logicalName, t]));
    return tables;
  }

  private async entitySetOf(logicalName: string): Promise<string> {
    if (!this.catalog) await this.listTables();
    const t = this.catalog!.get(logicalName);
    if (!t) throw new DataverseError('NOT_FOUND', `Table ${logicalName} not found`, 404);
    return t.entitySetName;
  }

  async getTable(logicalName: string): Promise<TableMetadata> {
    if (!/^[a-z0-9_]+$/.test(logicalName)) throw new DataverseError('VALIDATION', 'Invalid table name', 400);
    const entityPath = `EntityDefinitions(LogicalName=${odataString(logicalName)})`;
    const [entity, attributes, manyToOne, manyToMany, keys, ...casts] = await Promise.all([
      this.request<Raw>('GET', `${entityPath}?$select=${TABLE_SELECT}`).then((r) => r.data),
      this.getAll(`${entityPath}/Attributes?$select=${ATTRIBUTE_SELECT}`),
      this.getAll(
        `${entityPath}/ManyToOneRelationships?$select=SchemaName,ReferencedEntity,ReferencedAttribute,ReferencingEntity,ReferencingAttribute,ReferencingEntityNavigationPropertyName,IsCustomRelationship`,
      ),
      this.getAll(
        `${entityPath}/ManyToManyRelationships?$select=SchemaName,Entity1LogicalName,Entity2LogicalName,Entity1IntersectAttribute,Entity2IntersectAttribute,IntersectEntityName,IsCustomRelationship`,
      ),
      this.getAll(
        `${entityPath}/Keys?$select=LogicalName,SchemaName,DisplayName,KeyAttributes,EntityKeyIndexStatus`,
      ),
      ...ATTRIBUTE_CASTS.map((c) =>
        this.getAll(`${entityPath}/Attributes/Microsoft.Dynamics.CRM.${c.cast}?${c.query}`),
      ),
    ]);
    const extras = new Map<string, Raw>();
    for (const rows of casts)
      for (const r of rows) extras.set(r.LogicalName, { ...extras.get(r.LogicalName), ...r });
    const summary = normalizeTableSummary(entity);
    return {
      ...summary,
      attributes: attributes
        .map((a) => normalizeAttribute(a, extras.get(a.LogicalName)))
        .sort((a, b) => a.logicalName.localeCompare(b.logicalName)),
      manyToOne: manyToOne.map(normalizeManyToOne),
      manyToMany: manyToMany.map(normalizeManyToMany),
      keys: keys.map(normalizeKey),
    };
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  async countRecords(table: TableSummary): Promise<RecordCount> {
    const fetchXml = `<fetch aggregate="true"><entity name="${table.logicalName}"><attribute name="${table.primaryIdAttribute}" aggregate="count" alias="c"/></entity></fetch>`;
    try {
      const { data } = await this.request<Raw>(
        'GET',
        `${table.entitySetName}?fetchXml=${encodeURIComponent(fetchXml)}`,
      );
      return { count: Number(data.value?.[0]?.c ?? 0), approximate: false };
    } catch (err) {
      const e = toDataverseError(err);
      // FetchXML aggregates are limited to 50,000 rows and fail with 0x8004E023
      // (AggregateQueryRecordLimit exceeded). Fall back to the 24h snapshot count.
      // https://learn.microsoft.com/power-apps/developer/data-platform/fetchxml/aggregate-data
      const aggregateLimit = e.platformCode?.toLowerCase() === '0x8004e023';
      if (!aggregateLimit && e.code !== 'VALIDATION' && e.code !== 'SERVER_ERROR') throw e;
      const { data } = await this.request<Raw>(
        'GET',
        `RetrieveTotalRecordCount(EntityNames=@p)?@p=${encodeURIComponent(JSON.stringify([table.logicalName]))}`,
      );
      const values: number[] = data.EntityRecordCountCollection?.Values ?? [];
      return { count: Number(values[0] ?? 0), approximate: true };
    }
  }

  private selectList(table: TableMetadata, columns: string[]): { select: string; attrs: AttributeMeta[] } {
    const byName = new Map(table.attributes.map((a) => [a.logicalName, a]));
    const attrs = [...new Set(columns)].map((c) => byName.get(c)).filter((a): a is AttributeMeta => !!a);
    const select = [
      table.primaryIdAttribute,
      ...attrs
        .filter((a) => a.logicalName !== table.primaryIdAttribute)
        .map((a) => (LOOKUP_TYPES.has(a.type) ? `_${a.logicalName}_value` : a.logicalName)),
    ].join(',');
    return { select, attrs };
  }

  /** Dataverse ignores odata.maxpagesize above 5000; clamp so the preference is honoured. */
  private readonly clampPageSize = (pageSize?: number) =>
    pageSize ? Math.max(1, Math.min(pageSize, 5000)) : undefined;

  private readonly readHeaders = (pageSize?: number) => ({
    Prefer: [
      `odata.include-annotations="Microsoft.Dynamics.CRM.lookuplogicalname"`,
      this.clampPageSize(pageSize) ? `odata.maxpagesize=${this.clampPageSize(pageSize)}` : '',
    ]
      .filter(Boolean)
      .join(','),
  });

  async *queryRecords(
    table: TableMetadata,
    columns: string[],
    opts: { pageSize: number },
  ): AsyncGenerator<DvRecord[]> {
    const { select, attrs } = this.selectList(table, columns);
    let next: string | undefined =
      `${table.entitySetName}?$select=${select}&$orderby=${table.primaryIdAttribute}`;
    let absolute = false;
    while (next) {
      const { data }: { data: Raw } = await this.request<Raw>('GET', next, {
        headers: this.readHeaders(opts.pageSize),
        absolute,
      });
      const page = ((data.value ?? []) as Raw[]).map((r) =>
        normalizeRecord(r, table.primaryIdAttribute, attrs),
      );
      if (page.length) yield page;
      next = data['@odata.nextLink'];
      absolute = true;
    }
  }

  async retrieveByIds(table: TableMetadata, ids: string[], columns: string[]): Promise<DvRecord[]> {
    const { select, attrs } = this.selectList(table, columns);
    const out: DvRecord[] = [];
    const valid = ids.filter((id) => GUID.test(id));
    for (let i = 0; i < valid.length; i += 50) {
      const chunk = valid.slice(i, i + 50);
      const filter = `Microsoft.Dynamics.CRM.In(PropertyName=${odataString(table.primaryIdAttribute)},PropertyValues=[${chunk.map(odataString).join(',')}])`;
      const rows = await this.getAll(
        `${table.entitySetName}?$select=${select}&$filter=${encodeURIComponent(filter)}`,
        this.readHeaders(),
      );
      out.push(...rows.map((r) => normalizeRecord(r, table.primaryIdAttribute, attrs)));
    }
    return out;
  }

  async findByAlternateKey(
    table: TableMetadata,
    key: AlternateKeyMeta,
    values: Record<string, FieldValue>,
    columns: string[],
  ): Promise<DvRecord | null> {
    const byName = new Map(table.attributes.map((a) => [a.logicalName, a]));
    const parts: string[] = [];
    const criteria: Record<string, FieldValue> = {};
    let needsFilter = false;
    for (const attrName of key.attributes) {
      const v = values[attrName];
      const attr = byName.get(attrName);
      if (v === null || v === undefined || !attr) return null;
      criteria[attrName] = v;
      if (isLookupValue(v)) parts.push(`_${attrName}_value=${v.id}`);
      else if (typeof v === 'string') {
        // Values containing /, <, >, *, %, &, :, \, ? or + cannot be expressed in a key segment.
        if (KEY_UNSUPPORTED_CHARS.test(v)) needsFilter = true;
        parts.push(`${attrName}=${odataString(v).replace(/ /g, '%20')}`);
      } else parts.push(`${attrName}=${String(v)}`);
    }
    if (needsFilter) {
      const matches = await this.findByFields(table, criteria, columns, 2);
      return matches[0] ?? null;
    }
    const { select, attrs } = this.selectList(table, columns);
    try {
      const { data } = await this.request<Raw>(
        'GET',
        `${table.entitySetName}(${parts.join(',')})?$select=${select}`,
        {
          headers: this.readHeaders(),
        },
      );
      return normalizeRecord(data, table.primaryIdAttribute, attrs);
    } catch (err) {
      if (err instanceof DataverseError && err.code === 'NOT_FOUND') return null;
      throw err;
    }
  }

  /** Business-key lookup via $filter; returns up to `limit` matches so ambiguity is detectable. */
  async findByFields(
    table: TableMetadata,
    criteria: Record<string, FieldValue>,
    columns: string[],
    limit: number,
  ): Promise<DvRecord[]> {
    const byName = new Map(table.attributes.map((a) => [a.logicalName, a]));
    const clauses: string[] = [];
    for (const [field, value] of Object.entries(criteria)) {
      const attr = byName.get(field);
      if (!attr)
        throw new DataverseError('VALIDATION', `Column ${field} does not exist on ${table.logicalName}`, 400);
      if (value === null || value === undefined) {
        clauses.push(`${LOOKUP_TYPES.has(attr.type) ? `_${field}_value` : field} eq null`);
      } else if (isLookupValue(value)) {
        clauses.push(`_${field}_value eq ${value.id}`);
      } else if (typeof value === 'string') {
        clauses.push(`${field} eq ${odataString(value)}`);
      } else if (typeof value === 'boolean' || typeof value === 'number') {
        clauses.push(`${field} eq ${String(value)}`);
      } else {
        throw new DataverseError('VALIDATION', `Column ${field} cannot be used as a business key`, 400);
      }
    }
    const { select, attrs } = this.selectList(table, columns);
    const query = `${table.entitySetName}?$select=${select}&$top=${Math.max(1, Math.min(limit, 50))}&$filter=${encodeURIComponent(clauses.join(' and '))}`;
    const { data } = await this.request<Raw>('GET', query, { headers: this.readHeaders() });
    return ((data.value ?? []) as Raw[]).map((r) => normalizeRecord(r, table.primaryIdAttribute, attrs));
  }

  private async toPayload(table: TableMetadata, record: WriteRecord, forCreate: boolean): Promise<Raw> {
    const byName = new Map(table.attributes.map((a) => [a.logicalName, a]));
    const body: Raw = {};
    if (forCreate && record.id) body[table.primaryIdAttribute] = record.id;
    for (const [name, value] of Object.entries(record.values)) {
      const attr = byName.get(name);
      if (!attr)
        throw new DataverseError('VALIDATION', `Column ${name} does not exist on ${table.logicalName}`, 400);
      if (LOOKUP_TYPES.has(attr.type)) {
        if (value === null) {
          if (forCreate) continue;
          const rel = table.manyToOne.find((r) => r.referencingAttribute === name);
          if (rel?.navigationProperty) body[rel.navigationProperty] = null;
          continue;
        }
        if (!isLookupValue(value))
          throw new DataverseError('VALIDATION', `Column ${name} expects a lookup value`, 400);
        const rel = table.manyToOne.find(
          (r) => r.referencingAttribute === name && r.referencedEntity === value.logicalName,
        );
        if (!rel?.navigationProperty) {
          throw new DataverseError(
            'VALIDATION',
            `No relationship from ${table.logicalName}.${name} to ${value.logicalName}`,
            400,
          );
        }
        body[`${rel.navigationProperty}@odata.bind`] =
          `/${await this.entitySetOf(value.logicalName)}(${value.id})`;
      } else if (attr.type === 'MultiSelectPicklist' && Array.isArray(value)) {
        body[name] = value.join(',');
      } else {
        body[name] = value;
      }
    }
    return body;
  }

  private writeHeaders(options: WriteOptions): Record<string, string> {
    const headers: Record<string, string> = {};
    if (options.bypassCustomBusinessLogic)
      headers['MSCRM.BypassBusinessLogicExecution'] = 'CustomSync,CustomAsync';
    if (options.suppressFlowTriggers) headers['MSCRM.SuppressCallbackRegistrationExpanderJob'] = 'true';
    // Impersonation: the record is created/updated as this user, so createdby/modifiedby match
    // the source. CallerObjectId (Entra object id) is the form Microsoft prefers; MSCRMCallerID
    // (systemuserid) is the documented legacy fallback.
    // https://learn.microsoft.com/power-apps/developer/data-platform/webapi/impersonate-another-user-web-api
    if (options.impersonateObjectId) headers['CallerObjectId'] = options.impersonateObjectId;
    else if (options.impersonateUserId) headers['MSCRMCallerID'] = options.impersonateUserId;
    return headers;
  }

  private static readonly PRINCIPAL_QUERIES: Record<
    PrincipalTable,
    { set: string; id: string; select: string }
  > = {
    systemuser: {
      set: 'systemusers',
      id: 'systemuserid',
      select:
        'systemuserid,fullname,domainname,internalemailaddress,azureactivedirectoryobjectid,isdisabled,applicationid',
    },
    team: { set: 'teams', id: 'teamid', select: 'teamid,name,emailaddress,azureactivedirectoryobjectid' },
    businessunit: { set: 'businessunits', id: 'businessunitid', select: 'businessunitid,name,isdisabled' },
  };

  /** Users, teams or business units for principal mapping (owner / created by / modified by). */
  async listPrincipals(table: PrincipalTable): Promise<PrincipalDto[]> {
    const q = WebApiConnection.PRINCIPAL_QUERIES[table];
    // Owner teams (0) and Microsoft Entra group teams (2 = security group, 3 = Office group)
    // can own records; access teams (1) cannot and are excluded.
    // https://learn.microsoft.com/power-platform/admin/manage-teams
    const filter = table === 'team' ? '&$filter=teamtype eq 0 or teamtype eq 2 or teamtype eq 3' : '';
    const rows = await this.getAll(`${q.set}?$select=${q.select}${filter}`);
    return rows
      .filter((r) => !(table === 'systemuser' && r.applicationid))
      .map((r) => ({
        id: String(r[q.id]).toLowerCase(),
        name: r.fullname ?? r.name ?? '(unnamed)',
        login: r.domainname ?? null,
        email: r.internalemailaddress ?? r.emailaddress ?? null,
        entraObjectId: r.azureactivedirectoryobjectid
          ? String(r.azureactivedirectoryobjectid).toLowerCase()
          : null,
        disabled: Boolean(r.isdisabled),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Read-only probe: can the signed-in user act on behalf of another user here? */
  async checkImpersonation(targetUserId: string): Promise<{ allowed: boolean; message: string }> {
    if (!GUID.test(targetUserId)) return { allowed: false, message: 'No mapped target user to test with' };
    try {
      await this.request('GET', 'WhoAmI', { headers: { MSCRMCallerID: targetUserId } });
      return {
        allowed: true,
        message: 'The signed-in user may act on behalf of other users in this environment',
      };
    } catch (err) {
      const e = toDataverseError(err);
      if (e.code === 'FORBIDDEN' || e.code === 'VALIDATION') {
        return {
          allowed: false,
          message: `Impersonation is not permitted: ${e.message}. Grant prvActOnBehalfOfAnotherUser ("Act on Behalf of Another User") in the target.`,
        };
      }
      throw err;
    }
  }

  async createRecord(table: TableMetadata, record: WriteRecord, options: WriteOptions): Promise<string> {
    const body = await this.toPayload(table, record, true);
    const { headers } = await this.request('POST', table.entitySetName, {
      body,
      headers: this.writeHeaders(options),
    });
    const entityId = headers.get('OData-EntityId') ?? '';
    const match = entityId.match(/\(([0-9a-f-]{36})\)$/i);
    const id = match?.[1] ?? record.id;
    if (!id)
      throw new DataverseError(
        'UNKNOWN',
        'Create succeeded but no record id was returned',
        undefined,
        undefined,
        undefined,
        false,
      );
    return id.toLowerCase();
  }

  async updateRecord(
    table: TableMetadata,
    id: string,
    record: WriteRecord,
    options: WriteOptions,
  ): Promise<void> {
    if (!GUID.test(id)) throw new DataverseError('VALIDATION', 'Invalid record id', 400);
    const body = await this.toPayload(table, record, false);
    if (Object.keys(body).length === 0) return;
    // If-Match: * prevents PATCH from creating a record (no implicit upsert).
    await this.request('PATCH', `${table.entitySetName}(${id})`, {
      body,
      headers: { ...this.writeHeaders(options), 'If-Match': '*' },
    });
  }

  // ---------------------------------------------------------------------------
  // Automation detection
  // ---------------------------------------------------------------------------

  async detectAutomation(tables: TableSummary[]): Promise<AutomationInfo[]> {
    const results: AutomationInfo[] = [];
    for (const t of tables) {
      try {
        const steps = await this.getAll(
          `sdkmessageprocessingsteps?$select=name,stage,mode&$expand=sdkmessageid($select=name)&$filter=${encodeURIComponent(
            `statecode eq 0 and customizationlevel eq 1 and sdkmessagefilterid/primaryobjecttypecode eq ${odataString(t.logicalName)}`,
          )}`,
        );
        const relevantSteps = steps.filter((s) => ['Create', 'Update'].includes(s.sdkmessageid?.name));
        const workflows = await this.getAll(
          `workflows?$select=name,category&$filter=${encodeURIComponent(
            `statecode eq 1 and primaryentity eq ${odataString(t.logicalName)} and (category eq 0 or category eq 5) and type eq 1`,
          )}`,
        );
        results.push({
          table: t.logicalName,
          pluginSteps: relevantSteps.length,
          workflows: workflows.filter((w) => w.category === 0).length,
          flows: workflows.filter((w) => w.category === 5).length,
          details: [
            ...relevantSteps.slice(0, 10).map((s) => `Plug-in step: ${s.name}`),
            ...workflows.slice(0, 10).map((w) => `${w.category === 5 ? 'Flow' : 'Workflow'}: ${w.name}`),
          ],
          detectionSupported: true,
        });
      } catch (err) {
        const e = toDataverseError(err);
        this.opts.logger.warn(
          { table: t.logicalName, errorCode: e.code },
          'Automation detection unavailable',
        );
        results.push({
          table: t.logicalName,
          pluginSteps: 0,
          workflows: 0,
          flows: 0,
          details: [],
          detectionSupported: false,
        });
      }
    }
    return results;
  }
}
