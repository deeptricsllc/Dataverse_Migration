import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { decideWriteScope, describeWriteScope, normalizeEnvironmentKey } from '../../server/src/write-scope';
import { WebApiConnection } from '../../server/src/dataverse/web-api-connection';
import { attr, table } from './fixtures';

/**
 * Which environments may be written to, while the deployment calls itself read-only.
 *
 * The thing being guarded against is specific and was real: certifying one sandbox used to require
 * `REAL_TENANT_READ_ONLY=false`, which permitted writes to every environment the signed-in identity had a
 * role in — production included, since the only remaining check wants an administrator and the person
 * certifying is one. These cases exist to hold the replacement to the properties that make it safer than
 * what it replaced, rather than merely more granular.
 *
 * The two that matter most, and would be the whole point of an attack or an accident:
 *
 *   - unset must behave exactly as before, so no deployment loosens by upgrading;
 *   - naming production must not open production.
 */

const SANDBOX = {
  provider: 'dataverse',
  url: 'https://certsandbox.crm.dynamics.com',
  apiUrl: 'https://certsandbox.api.crm.dynamics.com',
  environmentType: 'Sandbox',
  displayName: 'Certification Sandbox',
};
const PRODUCTION = {
  provider: 'dataverse',
  url: 'https://live.crm.dynamics.com',
  apiUrl: 'https://live.api.crm.dynamics.com',
  environmentType: 'Production',
  displayName: 'Live',
};
/** The dangerous case: discovery could not classify it, so it might be anything. */
const UNCLASSIFIED = {
  provider: 'dataverse',
  url: 'https://mystery.crm.dynamics.com',
  apiUrl: null,
  environmentType: null,
  displayName: 'Mystery',
};

const cfg = (readOnly: boolean, scope: string[] = []) => ({
  REAL_TENANT_READ_ONLY: readOnly,
  certificationWriteEnvironments: scope,
});

describe('write scope: the default', () => {
  it('refuses every real write when no certification scope is set', () => {
    for (const env of [SANDBOX, PRODUCTION, UNCLASSIFIED]) {
      const d = decideWriteScope(cfg(true), env);
      expect(d.allowed, `${env.displayName} must be refused`).toBe(false);
      expect(d.reason).toBe('READ_ONLY_DEPLOYMENT');
    }
  });

  it('permits everything when the deployment is not read-only, as it always did', () => {
    for (const env of [SANDBOX, PRODUCTION, UNCLASSIFIED]) {
      expect(decideWriteScope(cfg(false), env).allowed).toBe(true);
    }
  });

  it('never disables a simulated environment, which holds no tenant data', () => {
    const demo = { provider: 'demo', url: 'https://x.demo.invalid', environmentType: 'Sandbox' };
    const demoSql = { provider: 'demosql', url: 'sqlserver://legacy', environmentType: null };
    expect(decideWriteScope(cfg(true), demo).reason).toBe('SIMULATED_ENVIRONMENT');
    expect(decideWriteScope(cfg(true), demoSql).allowed).toBe(true);
  });
});

describe('write scope: being on the list is necessary and not sufficient', () => {
  it('permits a listed non-production environment', () => {
    const d = decideWriteScope(cfg(true, [SANDBOX.url]), SANDBOX);
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('CERTIFICATION_SCOPE');
  });

  it('refuses an environment that is not listed, even with a scope open for another', () => {
    const d = decideWriteScope(cfg(true, [SANDBOX.url]), UNCLASSIFIED);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('NOT_IN_CERTIFICATION_SCOPE');
  });

  /**
   * The case this whole module exists for. Somebody will paste a production URL into the list — by a
   * copy-paste slip, or because two environments are called something similar. The list must not be the
   * only thing standing between that mistake and a write.
   */
  it('refuses production even when production is explicitly listed', () => {
    const d = decideWriteScope(cfg(true, [PRODUCTION.url, SANDBOX.url]), PRODUCTION);
    expect(d.allowed, 'listing production must not open production').toBe(false);
    expect(d.reason).toBe('PRODUCTION_OR_UNCLASSIFIED');
    expect(d.message).toContain('production environment');
  });

  it('refuses an unclassified environment even when listed, because it might be production', () => {
    const d = decideWriteScope(cfg(true, [UNCLASSIFIED.url]), UNCLASSIFIED);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('PRODUCTION_OR_UNCLASSIFIED');
    expect(d.message).toContain('not classified as non-production');
  });

  it('refuses a listed environment whose type Dataverse reports as something we do not know', () => {
    const d = decideWriteScope(cfg(true, [SANDBOX.url]), { ...SANDBOX, environmentType: 'SomethingNew' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('PRODUCTION_OR_UNCLASSIFIED');
  });

  it('matches on either URL discovery returns, and ignores case and a trailing slash', () => {
    // A URL copied from a browser usually has the slash, and an environment failing to match its own
    // allow-list entry is a confusing way to be safe.
    expect(decideWriteScope(cfg(true, ['https://certsandbox.crm.dynamics.com/']), SANDBOX).allowed).toBe(
      true,
    );
    expect(decideWriteScope(cfg(true, ['HTTPS://CERTSANDBOX.CRM.DYNAMICS.COM']), SANDBOX).allowed).toBe(true);
    // Listed by its web API URL rather than its application URL.
    expect(decideWriteScope(cfg(true, [SANDBOX.apiUrl]), SANDBOX).allowed).toBe(true);
  });

  it('does not match a different environment whose URL merely starts the same way', () => {
    const lookalike = { ...SANDBOX, url: 'https://certsandbox2.crm.dynamics.com', apiUrl: null };
    expect(decideWriteScope(cfg(true, [SANDBOX.url]), lookalike).allowed).toBe(false);
  });

  it('normalizes keys the way the configuration loader does', () => {
    expect(normalizeEnvironmentKey('  HTTPS://A.Example.COM/// ')).toBe('https://a.example.com');
    expect(normalizeEnvironmentKey(null)).toBe('');
  });
});

describe('write scope: the connector honours the decision', () => {
  const logger = pino({ level: 'silent' });
  const account = table('account', [attr('name', 'String', { isPrimaryName: true })]);
  const writeOptions = { bypassCustomBusinessLogic: false, suppressFlowTriggers: false };
  const unreachableFetch = (async () => {
    throw new Error('no request should leave the process when the scope refuses this environment');
  }) as unknown as typeof fetch;

  /**
   * The decision is only worth anything if the thing that can actually issue the HTTP request obeys it.
   * `readOnly` on the connection is now derived from the scope, so these two cases are the ends of that
   * wire: refused means no request leaves, permitted means the guard is not what stops it.
   */
  it('issues no request for an environment the scope refuses', async () => {
    const refused = decideWriteScope(cfg(true, [SANDBOX.url]), PRODUCTION);
    const conn = new WebApiConnection({
      url: PRODUCTION.url,
      apiVersion: 'v9.2',
      getAccessToken: async () => 't',
      logger,
      readOnly: !refused.allowed,
      fetchImpl: unreachableFetch,
    });
    await expect(
      conn.createRecord(account, { id: 'a', values: { name: 'X' } }, writeOptions),
    ).rejects.toMatchObject({ code: 'READ_ONLY_MODE' });
  });

  it('lets the request through for an environment the scope permits', async () => {
    const permitted = decideWriteScope(cfg(true, [SANDBOX.url]), SANDBOX);
    expect(permitted.allowed).toBe(true);
    let attempted: string | null = null;
    const conn = new WebApiConnection({
      url: SANDBOX.url,
      apiVersion: 'v9.2',
      getAccessToken: async () => 't',
      logger,
      readOnly: !permitted.allowed,
      fetchImpl: (async (url: string, init: { method: string }) => {
        attempted = `${init.method} ${url}`;
        return new Response('{}', {
          status: 204,
          headers: {
            'OData-EntityId': `${SANDBOX.url}/api/data/v9.2/accounts(${'0'.repeat(8)}-0000-0000-0000-000000000000)`,
          },
        });
      }) as unknown as typeof fetch,
    });
    await conn.createRecord(account, { id: 'a', values: { name: 'X' } }, writeOptions).catch(() => {});
    expect(attempted, 'a permitted environment must not be blocked by the read-only guard').toContain('POST');
  });
});

describe('write scope: it is visible', () => {
  it('states plainly that a read-only deployment has an open exception', () => {
    const d = describeWriteScope(cfg(true, ['https://certsandbox.crm.dynamics.com']));
    expect(d.realTenantReadOnly).toBe(true);
    expect(d.certificationWriteEnvironments).toHaveLength(1);
    expect(d.summary).toContain('1 environment(s) approved');
    expect(d.summary).toContain('Production and unclassified environments are refused');
  });

  it('says every write is refused when there is no exception', () => {
    expect(describeWriteScope(cfg(true)).summary).toContain('every write to a real environment is refused');
  });

  it('does not pretend to be read-only when it is not', () => {
    expect(describeWriteScope(cfg(false)).summary).toContain('Writes are permitted');
  });
});
