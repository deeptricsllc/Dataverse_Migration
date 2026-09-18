import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { classifyEnvironment } from '../../shared/domain';
import { isKeyUsable } from '../../shared/metadata';
import { scopeCandidates } from '../../server/src/auth/microsoft-identity';
import { organizationTypeName } from '../../server/src/dataverse/normalize';
import { backoffDelay } from '../../server/src/dataverse/retry';
import { DataverseError } from '../../server/src/dataverse/errors';
import { WebApiConnection } from '../../server/src/dataverse/web-api-connection';
import { attr, table } from './fixtures';

/**
 * Regression tests for the discrepancies found while auditing this client against Microsoft's
 * current Dataverse / Entra documentation. Each case names the rule it protects.
 */

const logger = pino({ level: 'silent' });
const writeOptions = { bypassCustomBusinessLogic: false, suppressFlowTriggers: false };

function mockFetch(responses: Response[], calls: { url: string; init: RequestInit }[]) {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request: ${url}`);
    return next;
  }) as unknown as typeof fetch;
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** 200 with the OData-EntityId header a create returns (Response forbids a 204 body). */
const created = () =>
  new Response('', {
    status: 200,
    headers: {
      'odata-entityid':
        'https://org.crm.dynamics.com/api/data/v9.2/accounts(11111111-1111-4111-8111-111111111111)',
    },
  });

const conn = (responses: Response[], calls: { url: string; init: RequestInit }[]) =>
  new WebApiConnection({
    url: 'https://org.crm.dynamics.com',
    apiVersion: 'v9.2',
    getAccessToken: async () => 'token',
    logger,
    retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 },
    fetchImpl: mockFetch(responses, calls),
  });

const headerOf = (init: RequestInit, name: string) =>
  (init.headers as Record<string, string> | undefined)?.[name];

describe('Entra scopes for a confidential client', () => {
  it('asks for /.default first, and keeps the documented fallbacks', () => {
    // Microsoft: confidential clients request the resource's /.default scope; some tenants only
    // accept the historical double-slash form or the explicit user_impersonation scope.
    expect(scopeCandidates('https://org.crm.dynamics.com/')).toEqual([
      'https://org.crm.dynamics.com/.default',
      'https://org.crm.dynamics.com//.default',
      'https://org.crm.dynamics.com/user_impersonation',
      'https://org.crm.dynamics.com//user_impersonation',
    ]);
  });
});

describe('impersonation headers', () => {
  it('prefers CallerObjectId (Entra object id) over the legacy MSCRMCallerID', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const account = table('account', [attr('name', 'String', { isPrimaryName: true })]);
    await conn([created()], calls).createRecord(
      account,
      { id: '11111111-1111-4111-8111-111111111111', values: { name: 'A' } },
      {
        ...writeOptions,
        impersonateUserId: '22222222-2222-4222-8222-222222222222',
        impersonateObjectId: '33333333-3333-4333-8333-333333333333',
      },
    );
    expect(headerOf(calls[0].init, 'CallerObjectId')).toBe('33333333-3333-4333-8333-333333333333');
    expect(headerOf(calls[0].init, 'MSCRMCallerID')).toBeUndefined();
  });

  it('falls back to MSCRMCallerID when no Entra object id is known', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const account = table('account', [attr('name', 'String', { isPrimaryName: true })]);
    await conn([created()], calls).createRecord(
      account,
      { id: '11111111-1111-4111-8111-111111111111', values: { name: 'A' } },
      {
        ...writeOptions,
        impersonateUserId: '22222222-2222-4222-8222-222222222222',
      },
    );
    expect(headerOf(calls[0].init, 'MSCRMCallerID')).toBe('22222222-2222-4222-8222-222222222222');
  });
});

describe('alternate key lookups', () => {
  const product = table('product', [attr('productnumber', 'String'), attr('name', 'String')], {
    keys: [
      {
        logicalName: 'key_productnumber',
        schemaName: 'key_productnumber',
        displayName: 'key',
        attributes: ['productnumber'],
      },
    ],
  });

  it('uses the key predicate for ordinary values', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    await conn([json(200, { value: [] })], calls).findByAlternateKey(
      product,
      product.keys[0],
      { productnumber: 'ABC-1' },
      ['name'],
    );
    expect(calls[0].url).toContain("productnumber='ABC-1'");
  });

  it('falls back to $filter when a key value contains a character Dataverse cannot address', async () => {
    // Microsoft: / < > * % & : \ ? + in an alternate key value break the key predicate, and the
    // record must be retrieved with $filter instead.
    for (const value of ['A/B', 'A?B', 'A+B', 'A%B', 'A&B', 'A:B', 'A<B', 'A>B', 'A*B', 'A\\B']) {
      const calls: { url: string; init: RequestInit }[] = [];
      await conn([json(200, { value: [] })], calls).findByAlternateKey(
        product,
        product.keys[0],
        { productnumber: value },
        ['name'],
      );
      expect(calls[0].url, value).toContain('$filter=');
      expect(calls[0].url, value).not.toContain('productnumber=');
    }
  });

  it('only treats an Active key index as enforceable', () => {
    expect(isKeyUsable({ logicalName: 'k', schemaName: 'k', displayName: 'k', attributes: ['a'] })).toBe(
      true,
    );
    expect(
      isKeyUsable({
        logicalName: 'k',
        schemaName: 'k',
        displayName: 'k',
        attributes: ['a'],
        status: 'Active',
      }),
    ).toBe(true);
    for (const status of ['Pending', 'InProgress', 'Failed']) {
      expect(
        isKeyUsable({ logicalName: 'k', schemaName: 'k', displayName: 'k', attributes: ['a'], status }),
      ).toBe(false);
    }
  });
});

describe('service protection limits', () => {
  it('honors a long Retry-After instead of capping it at the backoff maximum', () => {
    // Dataverse can ask for several minutes; ignoring that only makes the throttling worse.
    const policy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 30_000 };
    const throttled = (seconds: number) => new DataverseError('THROTTLED', 'limit', 429, undefined, seconds);
    expect(backoffDelay(1, policy, throttled(120))).toBe(120_000);
    expect(backoffDelay(1, policy, throttled(240))).toBe(240_000);
    // Still bounded, so a bad header cannot stall a run forever.
    expect(backoffDelay(1, policy, throttled(86_400))).toBe(300_000);
  });
});

describe('record counts', () => {
  it('falls back to an approximate count when the aggregate limit (0x8004E023) is hit', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const account = table('account', [attr('name', 'String', { isPrimaryName: true })]);
    const count = await conn(
      [
        json(400, { error: { code: '0x8004E023', message: 'AggregateQueryRecordLimit exceeded' } }),
        json(200, { EntityRecordCountCollection: { Keys: ['account'], Values: [50_000] } }),
      ],
      calls,
    ).countRecords(account);
    expect(count.approximate).toBe(true);
    expect(count.count).toBeGreaterThan(0);
  });
});

describe('owner-capable teams', () => {
  it('lists owner, access and AAD security group teams (types 0, 2 and 3)', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    await conn([json(200, { value: [] })], calls).listPrincipals('team');
    const filter = decodeURIComponent(calls[0].url);
    expect(filter).toContain('teamtype eq 0');
    expect(filter).toContain('teamtype eq 2');
    expect(filter).toContain('teamtype eq 3');
  });
});

describe('environment classification', () => {
  it('maps OrganizationType the way the Discovery Service documents it', () => {
    expect(organizationTypeName(0)).toBe('Customer'); // NOT "Production"
    expect(organizationTypeName(4)).toBe('Production');
    expect(organizationTypeName(5)).toBe('Sandbox');
    expect(organizationTypeName(6)).toBe('Sandbox');
    expect(organizationTypeName(13)).toBe('Developer');
    expect(organizationTypeName(undefined)).toBeNull();
  });

  it('does not treat an unrecognized type as safe', () => {
    expect(classifyEnvironment(organizationTypeName(0))).toBe('UNKNOWN');
    expect(classifyEnvironment(organizationTypeName(4))).toBe('PRODUCTION');
    expect(classifyEnvironment(organizationTypeName(5))).toBe('NON_PRODUCTION');
  });
});

describe('paging preference', () => {
  it('clamps odata.maxpagesize to the documented maximum of 5000', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const account = table('account', [attr('name', 'String', { isPrimaryName: true })]);
    const pages = conn([json(200, { value: [] })], calls).queryRecords(account, ['name'], {
      pageSize: 100_000,
    });
    await pages.next();
    expect(headerOf(calls[0].init, 'Prefer')).toContain('odata.maxpagesize=5000');
  });
});
