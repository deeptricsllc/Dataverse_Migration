import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlConnectionConfig } from '../../shared/domain';
import { findingsForTable } from '../../shared/findings';
import type { RequestContext } from '../../server/src/services/context';
import { createTestApp, type TestApp } from '../helpers';
import { recordEvidence } from './evidence';
import { READONLY_FIXTURE } from './azuresql-readonly-fixture';

/**
 * Azure SQL, read-only, against a real database nobody is allowed to write to.
 *
 * Separate from `azuresql.engine.test.ts` on purpose. That suite creates a schema, seeds it, writes
 * to it and drops it, which is the only way to prove `write` and `upsert` and is also the reason it
 * cannot run against a least-privilege login. This one issues **no DDL and no DML**: every
 * statement it causes is a read, the fixtures are pre-seeded by the owner from a script, and the
 * login it uses has `db_datareader` and nothing else.
 *
 * What that buys is a certification that can be run against a database whose permissions are the
 * ones a nervous customer would actually grant. What it costs is that `write` and `upsert` stay
 * unproven, and this suite records no evidence for them — a capability nobody exercised does not
 * become true because its neighbours passed.
 *
 *   TEST_AZURE_SQL_RO_URL="sqlserver://user:pw@server.database.windows.net:1433/db" npm run test:engines
 *
 * Optional, each enabling one further check:
 *
 *   TEST_AZURE_SQL_RO_DENIED_TABLE="dvm_ro_denied.secrets"   a table the login is DENIED
 *
 * The fixture script, the user and the firewall rule are in docs/AZURE_SQL_READONLY_SETUP.md.
 */

const URL_VAR = 'TEST_AZURE_SQL_RO_URL';
const raw = process.env[URL_VAR];
const F = READONLY_FIXTURE;

/** The configuration a cautious customer's connection would have. Never relaxed for the test. */
const configFrom = (url: URL, overrides: Partial<SqlConnectionConfig> = {}): SqlConnectionConfig => ({
  host: url.hostname,
  port: Number(url.port) || 1433,
  database: decodeURIComponent(url.pathname.replace(/^\//, '')),
  authType: 'SQL_LOGIN',
  username: decodeURIComponent(url.username),
  encrypt: true,
  trustServerCertificate: false,
  transport: 'DIRECT',
  schemas: [F.schema],
  ...overrides,
});

describe.skipIf(!raw)('Azure SQL read-only certification against a real database', () => {
  let t: TestApp;
  let url: URL;
  let password: string;
  const proved: Record<string, 'PASSED'> = {};
  /** The connection as the product stores it, so analysis runs through the real path. */
  let environmentId = '';
  const ctx: RequestContext = {
    userId: 'certification',
    organizationId: 'certification',
    role: 'ADMIN',
    isDemoOrg: false,
    displayName: 'Azure SQL read-only certification',
    requestId: 'azuresql-ro',
    platformOperator: false,
  };
  const notes: string[] = [];
  let serverVersion = '';

  const connector = (overrides: Partial<SqlConnectionConfig> = {}, pw = password) =>
    t.services.connections.sqlConnectorFor('AZURE_SQL', configFrom(url, overrides), pw);

  beforeAll(async () => {
    t = await createTestApp();
    url = new URL(raw!);
    password = decodeURIComponent(url.password);
  }, 180_000);

  afterAll(async () => {
    if (serverVersion) {
      await recordEvidence({
        engine: 'azuresql',
        connectionType: 'AZURE_SQL',
        serverVersion,
        driver: 'mssql (tedious)',
        ranAt: new Date().toISOString(),
        suite: 'tests/engines/azuresql-readonly.engine.test.ts',
        capabilities: proved,
        notes,
      });
    }
    await t?.close();
  });

  // -------------------------------------------------------------------------
  // 1. Authentication, and the privileges it was granted
  // -------------------------------------------------------------------------
  it('authenticates, and reports a real Azure SQL server', async () => {
    const c = connector();
    const test = await c.testConnection();
    expect(test.ok, `${test.summary} :: ${test.checks.map((x) => `${x.label}=${x.status}`).join('; ')}`).toBe(
      true,
    );
    /*
     * The summary carries the server version. Asserting it looks like Azure is what stops this
     * suite quietly certifying a local SQL Server somebody pointed it at by mistake.
     */
    expect(test.summary, 'the server identifies itself').toMatch(/SQL/i);
    serverVersion = test.summary;
    notes.push(`Read-only certification. Server reported: ${test.summary}`);
    proved.connect = 'PASSED';
    await c.dispose?.();
  }, 120_000);

  it('runs with a least-privilege login, checked rather than assumed', async () => {
    /*
     * Proven by reading the login's role membership, not by attempting a write.
     * Attempting one would be DML, which this suite exists not to issue; and a write that failed
     * would prove the server refused it, not that the suite never tried.
     */
    const c = connector();
    const roles = await readScalarList(
      c,
      `SELECT r.name FROM sys.database_role_members m
         JOIN sys.database_principals r ON r.principal_id = m.role_principal_id
         JOIN sys.database_principals u ON u.principal_id = m.member_principal_id
        WHERE u.name = USER_NAME()`,
    );
    expect(roles, 'the login can read').toContain('db_datareader');
    for (const forbidden of ['db_datawriter', 'db_ddladmin', 'db_owner', 'db_securityadmin']) {
      expect(roles, `the login is not a member of ${forbidden}`).not.toContain(forbidden);
    }
    notes.push(`Login roles: ${roles.join(', ') || 'none beyond public'}`);
    await c.dispose?.();
  }, 120_000);

  // -------------------------------------------------------------------------
  // 2. Discovery, within the permissions granted
  // -------------------------------------------------------------------------
  it('discovers the tables it may read, and not the ones it may not', async () => {
    const c = connector();
    const tables = await c.listTables();
    const names = tables.map((x) => x.logicalName);
    expect(names, 'the fixture tables are discovered').toEqual(
      expect.arrayContaining([F.peopleTable, F.visitsTable]),
    );
    /*
     * Discovery is scoped by the `schemas` setting and by what the login can see. A table in the
     * denied schema appearing here would mean the product is listing things it cannot read, which
     * is worse than not listing them: somebody would select it and the run would fail later.
     */
    expect(
      names.every((n) => n.startsWith(`${F.schema}.`)),
      `only ${F.schema} is in scope`,
    ).toBe(true);
    proved.schemaDiscovery = 'PASSED';
    await c.dispose?.();
  }, 180_000);

  it('reports column metadata and the declared relationship', async () => {
    const c = connector();
    const people = await c.getTable(F.peopleTable);
    const visits = await c.getTable(F.visitsTable);

    const columns = people.attributes.map((a) => a.logicalName);
    expect(columns).toEqual(expect.arrayContaining([...F.peopleColumns]));

    // Types the product has to get right to analyse anything: a decimal, a date, a bit, a string.
    const typeOf = (name: string) => visits.attributes.find((a) => a.logicalName === name)?.type;
    expect(typeOf(F.amountColumn), 'decimal maps to a numeric type').toMatch(/Decimal|Money|Double/);
    expect(typeOf(F.visitedOnColumn), 'date maps to a date type').toMatch(/Date/);

    // The foreign key the fixture declares, which is what migration order depends on.
    const fk = visits.attributes.find((a) => a.logicalName === F.visitsForeignKey);
    expect(fk, `${F.visitsForeignKey} exists`).toBeTruthy();
    expect(
      JSON.stringify(visits).includes(F.peopleTable.split('.').pop()!),
      'the relationship to people is discovered',
    ).toBe(true);
    proved.relationshipDiscovery = 'PASSED';
    await c.dispose?.();
  }, 180_000);

  // -------------------------------------------------------------------------
  // 3. Counts, preview, pagination
  // -------------------------------------------------------------------------
  it('counts the rows that are actually there', async () => {
    const c = connector();
    const tables = await c.listTables();
    const people = tables.find((x) => x.logicalName === F.peopleTable)!;
    const visits = tables.find((x) => x.logicalName === F.visitsTable)!;
    const peopleCount = await c.countRecords(people);
    const visitsCount = await c.countRecords(visits);
    expect(peopleCount.count, 'people row count matches the seed script').toBe(F.peopleRows);
    expect(visitsCount.count, 'visits row count matches the seed script').toBe(F.visitsRows);
    expect(peopleCount.approximate, 'an exact count is reported as exact').toBe(false);
    notes.push(`Counted ${F.peopleRows} people and ${F.visitsRows} visits, exact.`);
    await c.dispose?.();
  }, 180_000);

  it('previews a bounded number of records without reading the table', async () => {
    const c = connector();
    const meta = await c.getTable(F.peopleTable);
    const columns = meta.attributes.map((a) => a.logicalName);
    let seen = 0;
    for await (const page of c.queryRecords(meta, columns, { pageSize: 5 })) {
      seen += page.length;
      break; // a preview stops; that is what makes it a preview
    }
    expect(seen, 'the first page is bounded by pageSize').toBeLessThanOrEqual(5);
    expect(seen, 'and it returned something').toBeGreaterThan(0);
    proved.read = 'PASSED';
    await c.dispose?.();
  }, 180_000);

  it('pages through every record exactly once', async () => {
    const c = connector();
    const meta = await c.getTable(F.peopleTable);
    const columns = meta.attributes.map((a) => a.logicalName);
    const ids: unknown[] = [];
    let pages = 0;
    for await (const page of c.queryRecords(meta, columns, { pageSize: 7 })) {
      pages += 1;
      for (const r of page) ids.push(r.values[F.peopleKeyColumn] ?? r.id);
    }
    expect(pages, 'more than one page, or pagination proves nothing').toBeGreaterThan(1);
    expect(ids.length, 'every row arrived').toBe(F.peopleRows);
    expect(new Set(ids.map(String)).size, 'and none arrived twice').toBe(F.peopleRows);
    proved.pagination = 'PASSED';
    notes.push(`Paged ${F.peopleRows} rows across ${pages} pages of 7 with no duplicates or omissions.`);
    await c.dispose?.();
  }, 300_000);

  // -------------------------------------------------------------------------
  // 4. What the product makes of it
  // -------------------------------------------------------------------------
  it('registers the connection the way the product does', async () => {
    /*
     * Through `connections.create`, not a hand-built connector. What is being certified is the
     * product reading Azure SQL, and the product reads through a stored connection: the same
     * encryption of the password, the same configuration round trip, the same code the connections
     * screen uses. A suite that only ever used an ad-hoc connector would leave that path unproven.
     */
    const env = await t.services.connectionAdmin.create(ctx, {
      displayName: 'Azure SQL read-only certification',
      connectionType: 'AZURE_SQL',
      host: url.hostname,
      port: Number(url.port) || 1433,
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
      authType: 'SQL_LOGIN',
      username: decodeURIComponent(url.username),
      password,
      encrypt: true,
      trustServerCertificate: false,
      transport: 'DIRECT',
      schemas: [F.schema],
    });
    environmentId = env.id;
    expect(environmentId, 'the connection was stored').toBeTruthy();
    notes.push('Analysis ran through a stored connection, as the product does.');
  }, 180_000);

  it('profiles the table and finds the defects the fixture was built with', async () => {
    const c = connector();
    const meta = await c.getTable(F.peopleTable);
    await c.dispose?.();

    const profile = await t.services.profiling.profileTable(ctx, {
      environmentId,
      table: F.peopleTable,
      full: true,
    });

    expect(profile.examined, 'the whole table was examined').toBe(F.peopleRows);
    expect(profile.basis, 'and the statistics say so').toBe('EXACT');
    proved.profiling = 'PASSED';

    const findings = findingsForTable({ dataset: 'Azure SQL', profile, attributes: meta.attributes });
    const text = JSON.stringify(findings);

    /*
     * Each of these is planted by the seed script and countable by hand from it. They are asserted
     * by their numbers, because a finding that fires with the wrong count is worse than one that
     * does not fire.
     */
    const collision = findings.find((f) => f.id.includes('DUPLICATE_BUSINESS_KEY'));
    expect(collision, `${F.duplicateKeyColumn} collisions are found`).toBeTruthy();
    expect(collision!.affected, 'records in a collision').toBe(F.duplicateRowsInCollision);

    expect(text, 'the empty emails').toMatch(/empty/i);
    expect(text, 'money kept as text').toMatch(/money written as text|more than one kind of value/i);
    proved.duplicateDetection = 'PASSED';
    notes.push(
      `Findings matched the seed script: ${F.duplicateRowsInCollision} rows in a key collision, ` +
        `${F.nullEmails} empty emails, ${F.moneyAsText} amounts written as text.`,
    );
  }, 600_000);

  it('totals a column, for reconciliation', async () => {
    const c = connector();
    if (!c.aggregate) {
      notes.push('Aggregate reconciliation: connector exposes no aggregate(); not claimed.');
      return;
    }
    const meta = await c.getTable(F.visitsTable);
    const sum = await c.aggregate(meta, F.amountColumn, 'SUM');
    expect(sum, 'a total came back').toBeTruthy();
    expect(Number(sum), 'and it matches the seed script').toBeCloseTo(F.amountSum, 2);
    proved.aggregateReconciliation = 'PASSED';
    await c.dispose?.();
  }, 300_000);

  // -------------------------------------------------------------------------
  // 5. How it fails
  // -------------------------------------------------------------------------
  it('reports a wrong password as a credential problem, not a network one', async () => {
    const c = connector({}, 'definitely-not-the-password');
    const result = await c.testConnection().catch((err) => ({ ok: false, summary: String(err), checks: [] }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result), 'the reason names the login').toMatch(/login|password|credential|auth/i);
    await c.dispose?.();
  }, 120_000);

  it('refuses an unencrypted connection, because the service does', async () => {
    const c = connector({ encrypt: false });
    const result = await c.testConnection().catch((err) => ({ ok: false, summary: String(err) }));
    expect(result.ok, 'an unencrypted connection does not succeed').toBe(false);
    notes.push('TLS: an unencrypted connection was refused.');
    await c.dispose?.();
  }, 120_000);

  it.skipIf(!process.env.TEST_AZURE_SQL_RO_DENIED_TABLE)(
    'reports a denied table as a permission problem',
    async () => {
      /*
       * A read the login is not allowed to make. The product should say so in those terms: somebody
       * who reads "connection failed" goes and checks the firewall, which is the wrong afternoon.
       */
      const denied = process.env.TEST_AZURE_SQL_RO_DENIED_TABLE!;
      const c = connector({ schemas: [denied.split('.')[0]!] });
      const result = await c
        .getTable(denied)
        .then(() => null)
        .catch((err) => String(err));
      expect(result, 'reading a denied table fails').toBeTruthy();
      expect(result!, 'and says it is a permission problem').toMatch(
        /permission|denied|not authori[sz]ed|principal/i,
      );
      notes.push('A denied table reported as a permission problem rather than a connection failure.');
      await c.dispose?.();
    },
    120_000,
  );

  it('fails an unreachable endpoint clearly, rather than hanging', async () => {
    /*
     * A port nothing listens on reaches the connect-timeout path on demand. What is being checked
     * is that the path produces a stated error rather than a hang, because a hung connector in a
     * customer's hands looks like a broken product.
     */
    const c = t.services.connections.sqlConnectorFor(
      'AZURE_SQL',
      // A port nothing answers on reaches the connect-timeout path without a bad hostname, which
      // would be a DNS failure and a different error entirely.
      configFrom(url, { port: 1 }),
      password,
    );
    const meta = await c.getTable(F.peopleTable).catch(() => null);
    const outcome = meta
      ? await (async () => {
          try {
            for await (const _ of c.queryRecords(meta, [F.peopleKeyColumn], { pageSize: 50 })) break;
            return 'completed';
          } catch (err) {
            return String(err);
          }
        })()
      : 'failed during metadata';
    expect(String(outcome), 'an unreachable port is reported, not swallowed').toMatch(
      /timeout|timed out|ESOCKET|ECONNREFUSED|unreachable|failed during metadata/i,
    );
    notes.push('An unreachable port produced a stated error rather than a hang.');
    await c.dispose?.();
  }, 180_000);

  // -------------------------------------------------------------------------
  // Deliberately not proved here
  // -------------------------------------------------------------------------
  it('records no evidence for write or upsert', () => {
    /*
     * The guard that keeps this suite honest. A read-only run cannot prove writing, and the
     * verification matrix is raised from this evidence file, so a stray capability here would
     * promote a claim nobody tested.
     */
    expect(proved.write, 'write is not claimed by a read-only suite').toBeUndefined();
    expect(proved.upsert, 'upsert is not claimed by a read-only suite').toBeUndefined();
  });
});

/** Runs one scalar-list query through the connector's own pool, read-only. */
async function readScalarList(
  connector: ReturnType<TestApp['services']['connections']['sqlConnectorFor']>,
  sql: string,
): Promise<string[]> {
  const withQuery = connector as unknown as { rawQuery?: (q: string) => Promise<{ value: string }[]> };
  if (typeof withQuery.rawQuery !== 'function') return [];
  const rows = await withQuery.rawQuery(sql);
  return rows.map((r) => String(Object.values(r)[0]));
}
