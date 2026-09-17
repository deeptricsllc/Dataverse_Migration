import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { SecretBox } from '../../server/src/lib/crypto';
import { scrubSecrets } from '../../server/src/logger';
import { DataverseError, classifyHttpError } from '../../server/src/dataverse/errors';
import { normalizeAttribute, normalizeRecord } from '../../server/src/dataverse/normalize';
import { backoffDelay, withRetry } from '../../server/src/dataverse/retry';
import { GlobalDiscoveryProvider } from '../../server/src/dataverse/discovery';
import { WebApiConnection } from '../../server/src/dataverse/web-api-connection';
import { attr, lookup, table } from './fixtures';

const logger = pino({ level: 'silent' });
const fastRetry = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 };

function mockFetch(responses: (Response | Error)[], calls: { url: string; init: RequestInit }[] = []) {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('Dataverse error classification & retry', () => {
  it('classifies throttling, duplicates, validation and auth errors', () => {
    expect(classifyHttpError(429, {}, '7')).toMatchObject({
      code: 'THROTTLED',
      retryable: true,
      retryAfterSeconds: 7,
    });
    expect(classifyHttpError(400, { error: { code: '0x80040237', message: 'dup' } })).toMatchObject({
      code: 'DUPLICATE_RECORD',
      retryable: false,
    });
    expect(classifyHttpError(400, { error: { code: '0x80040217', message: 'missing' } }).code).toBe(
      'REFERENCE_NOT_FOUND',
    );
    expect(classifyHttpError(400, { error: { message: 'bad' } })).toMatchObject({
      code: 'VALIDATION',
      retryable: false,
    });
    expect(classifyHttpError(401, {}).code).toBe('AUTH_REQUIRED');
    expect(classifyHttpError(503, {}).retryable).toBe(true);
  });

  it('honors Retry-After and caps backoff', () => {
    const policy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 30_000 };
    expect(backoffDelay(1, policy, new DataverseError('THROTTLED', 't', 429, undefined, 3))).toBe(3000);
    expect(backoffDelay(10, policy, undefined, () => 1)).toBe(30_000);
  });

  it('retries transient errors but not permanent ones', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          if (attempts < 3) throw new DataverseError('THROTTLED', 'slow down', 429);
          return 'ok';
        },
        { policy: fastRetry },
      ),
    ).resolves.toBe('ok');
    let permanent = 0;
    await expect(
      withRetry(
        async () => {
          permanent++;
          throw new DataverseError('VALIDATION', 'bad', 400);
        },
        { policy: fastRetry },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(permanent).toBe(1);
  });

  it('never leaks tokens in messages', () => {
    const e = new DataverseError(
      'UNKNOWN',
      'failed with Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    );
    expect(e.message).not.toContain('eyJ');
    expect(scrubSecrets('refresh_token=abc&x=1')).toBe('refresh_token=[REDACTED]&x=1');
  });
});

describe('metadata & record normalization', () => {
  it('normalizes attribute metadata with type-specific details', () => {
    const a = normalizeAttribute(
      {
        LogicalName: 'industrycode',
        SchemaName: 'IndustryCode',
        AttributeType: 'Picklist',
        AttributeTypeName: { Value: 'PicklistType' },
        DisplayName: { UserLocalizedLabel: { Label: 'Industry' } },
        RequiredLevel: { Value: 'None' },
        IsValidForCreate: true,
        IsValidForUpdate: true,
        IsValidForRead: true,
      },
      {
        OptionSet: {
          Name: 'industry',
          IsGlobal: false,
          Options: [{ Value: 1, Label: { UserLocalizedLabel: { Label: 'Accounting' } } }],
        },
      },
    );
    expect(a).toMatchObject({
      type: 'Picklist',
      displayName: 'Industry',
      options: [{ value: 1, label: 'Accounting' }],
      optionSetName: 'industry',
    });
  });

  it('normalizes lookup and multi-select record values', () => {
    const record = normalizeRecord(
      {
        contactid: 'AAAA',
        _parentcustomerid_value: 'BBBB',
        '_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'account',
        hobbies: '1,3',
      },
      'contactid',
      [lookup('parentcustomerid', ['account', 'contact']), attr('hobbies', 'MultiSelectPicklist')],
    );
    expect(record).toEqual({
      id: 'aaaa',
      values: { parentcustomerid: { id: 'bbbb', logicalName: 'account' }, hobbies: [1, 3] },
    });
  });
});

describe('WebApiConnection', () => {
  const account = table('account', [attr('name', 'String'), lookup('parentaccountid', ['account'])]);

  it('pages through records with auth header, then follows nextLink', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const conn = new WebApiConnection({
      url: 'https://org.crm.dynamics.com/',
      apiVersion: 'v9.2',
      getAccessToken: async () => 'token-123',
      logger,
      retryPolicy: fastRetry,
      fetchImpl: mockFetch(
        [
          json(200, {
            value: [{ accountid: '1', name: 'A' }],
            '@odata.nextLink': 'https://org.crm.dynamics.com/api/data/v9.2/accounts?$skiptoken=x',
          }),
          json(200, { value: [{ accountid: '2', name: 'B' }] }),
        ],
        calls,
      ),
    });
    const pages = [];
    for await (const p of conn.queryRecords(account, ['name', 'parentaccountid'], { pageSize: 1 }))
      pages.push(p);
    expect(pages.flat().map((r) => r.id)).toEqual(['1', '2']);
    expect(calls[0].url).toContain('accounts?$select=accountid,name,_parentaccountid_value');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer token-123');
    expect((calls[0].init.headers as Record<string, string>).Prefer).toContain('odata.maxpagesize=1');
    expect(calls[1].url).toContain('$skiptoken=x');
  });

  it('creates records with @odata.bind lookups and bypass headers only when requested', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const conn = new WebApiConnection({
      url: 'https://org.crm.dynamics.com',
      apiVersion: 'v9.2',
      getAccessToken: async () => 't',
      logger,
      retryPolicy: fastRetry,
      fetchImpl: mockFetch(
        [
          json(200, {
            value: [
              {
                LogicalName: 'account',
                SchemaName: 'Account',
                EntitySetName: 'accounts',
                PrimaryIdAttribute: 'accountid',
              },
            ],
          }),
          new Response(null, {
            status: 204,
            headers: {
              'OData-EntityId':
                'https://org.crm.dynamics.com/api/data/v9.2/accounts(11111111-2222-3333-4444-555555555555)',
            },
          }),
        ],
        calls,
      ),
    });
    const id = await conn.createRecord(
      account,
      {
        id: '11111111-2222-3333-4444-555555555555',
        values: {
          name: 'X',
          parentaccountid: { id: '99999999-2222-3333-4444-555555555555', logicalName: 'account' },
        },
      },
      { bypassCustomBusinessLogic: false, suppressFlowTriggers: false },
    );
    expect(id).toBe('11111111-2222-3333-4444-555555555555');
    const post = calls[1];
    expect(JSON.parse(post.init.body as string)).toEqual({
      accountid: '11111111-2222-3333-4444-555555555555',
      name: 'X',
      'parentaccountid@odata.bind': '/accounts(99999999-2222-3333-4444-555555555555)',
    });
    expect(
      (post.init.headers as Record<string, string>)['MSCRM.BypassBusinessLogicExecution'],
    ).toBeUndefined();
  });

  it('retries throttled requests and surfaces permanent failures', async () => {
    const conn = new WebApiConnection({
      url: 'https://org.crm.dynamics.com',
      apiVersion: 'v9.2',
      getAccessToken: async () => 't',
      logger,
      retryPolicy: fastRetry,
      fetchImpl: mockFetch([
        json(429, { error: { message: 'limit' } }),
        json(200, { UserId: 'u', BusinessUnitId: 'b', OrganizationId: 'o' }),
        json(403, { error: { code: '0x80040220', message: 'no privilege' } }),
      ]),
    });
    await expect(conn.whoAmI()).resolves.toEqual({ userId: 'u', businessUnitId: 'b', organizationId: 'o' });
    await expect(conn.whoAmI()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('updates with If-Match to avoid accidental creation', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const conn = new WebApiConnection({
      url: 'https://org.crm.dynamics.com',
      apiVersion: 'v9.2',
      getAccessToken: async () => 't',
      logger,
      retryPolicy: fastRetry,
      fetchImpl: mockFetch([new Response(null, { status: 204 })], calls),
    });
    await conn.updateRecord(
      account,
      '11111111-2222-3333-4444-555555555555',
      { values: { name: 'Y' } },
      { bypassCustomBusinessLogic: true, suppressFlowTriggers: true },
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].init.method).toBe('PATCH');
    expect(headers['If-Match']).toBe('*');
    expect(headers['MSCRM.BypassBusinessLogicExecution']).toBe('CustomSync,CustomAsync');
    expect(headers['MSCRM.SuppressCallbackRegistrationExpanderJob']).toBe('true');
  });
});

describe('environment discovery', () => {
  it('maps Global Discovery instances', async () => {
    const provider = new GlobalDiscoveryProvider({
      discoveryUrl: 'https://globaldisco.crm.dynamics.com',
      getDiscoveryToken: async () => 't',
      logger,
      fetchImpl: mockFetch([
        json(200, {
          value: [
            {
              Id: 'org1',
              FriendlyName: 'Contoso Dev',
              Url: 'https://contoso-dev.crm.dynamics.com/',
              ApiUrl: 'https://contoso-dev.api.crm.dynamics.com',
              UniqueName: 'orgdev',
              OrganizationType: 5,
              Region: 'NA',
              Version: '9.2',
              State: 0,
              EnvironmentId: 'env1',
            },
          ],
        }),
      ]),
    });
    const [env] = await provider.discover();
    expect(env).toMatchObject({
      provider: 'dataverse',
      displayName: 'Contoso Dev',
      url: 'https://contoso-dev.crm.dynamics.com',
      environmentType: 'Sandbox',
      dataverseAvailable: true,
      environmentId: 'env1',
    });
  });
});

describe('secret box', () => {
  it('round-trips and detects tampering', () => {
    const box = new SecretBox('a'.repeat(40), 'test');
    const enc = box.encrypt('refresh-token-cache');
    expect(enc).not.toContain('refresh');
    expect(box.decrypt(enc)).toBe('refresh-token-cache');
    const tampered = enc.slice(0, -2) + (enc.endsWith('A') ? 'BB' : 'AA');
    expect(() => box.decrypt(tampered)).toThrow();
    expect(() => new SecretBox('b'.repeat(40), 'test').decrypt(enc)).toThrow();
  });
});
