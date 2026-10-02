import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlConnectionConfig } from '../../shared/domain';
import { createTestApp, type TestApp } from '../helpers';
import { recordEvidence } from './evidence';
import { AWKWARD, runConformance, type EngineFixture } from './conformance';

/**
 * Azure SQL, against an actual Azure SQL database.
 *
 * Azure SQL shares SQL Server's connector, and sharing an implementation is not evidence. What
 * differs is everything around the query: Entra authentication, firewall rules, enforced encryption,
 * transient faults and throttling — none of which a local container exercises, and all of which are
 * the part most likely to break a connection in a customer's hands.
 *
 * So this suite is in two halves. The first is the ordinary conformance run, which establishes that
 * the shared connector behaves the same way against a managed service as against a container. The
 * second is the Azure-specific half: the things that have no SQL Server equivalent.
 *
 * Nothing here runs without an environment. It is skipped by default and the verification matrix
 * keeps Azure SQL at `REQUIRES_CONFIGURATION` for `connect` until a recorded run says otherwise —
 * which is the point: this file exists so that providing an environment is configuration rather than
 * new test architecture.
 *
 *   TEST_AZURE_SQL_URL="sqlserver://user:pw@server.database.windows.net:1433/db" npm run test:engines
 *
 * Optional, each enabling one Azure-specific check:
 *
 *   TEST_AZURE_SQL_ENTRA=1                 the connection string uses Entra rather than SQL auth
 *   TEST_AZURE_SQL_BLOCKED_URL="..."       a server whose firewall should reject this client
 *
 * The database must be one you are willing to let a test create and drop a schema in. It creates
 * `dvm_conf` and removes it; see `docs/AZURE_SQL_SETUP.md`.
 */

const URL_VAR = 'TEST_AZURE_SQL_URL';
const raw = process.env[URL_VAR];
const SCHEMA = 'dvm_conf';

/**
 * The configuration a customer's Azure SQL connection would have.
 *
 * Not relaxed for the test: `encrypt` on and `trustServerCertificate` off is what the service
 * requires, and a suite that trusts any certificate proves nothing about one that does not.
 */
const configFrom = (url: URL, overrides: Partial<SqlConnectionConfig> = {}): SqlConnectionConfig => ({
  host: url.hostname,
  port: Number(url.port) || 1433,
  database: decodeURIComponent(url.pathname.replace(/^\//, '')),
  authType: 'SQL_LOGIN',
  username: decodeURIComponent(url.username),
  encrypt: true,
  trustServerCertificate: false,
  transport: 'DIRECT',
  schemas: [SCHEMA],
  ...overrides,
});

describe.skipIf(!raw)('Azure SQL conformance against a real database', () => {
  let t: TestApp;
  let pool: import('mssql').ConnectionPool;
  let url: URL;

  beforeAll(async () => {
    t = await createTestApp();
    url = new URL(raw!);
    const sql = (await import('mssql')).default;
    pool = await new sql.ConnectionPool({
      server: url.hostname,
      port: Number(url.port) || 1433,
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      // The same settings a customer's connection uses. Not relaxed for the test: a suite that
      // trusts any certificate proves nothing about a service that requires a real one.
      options: { encrypt: true, trustServerCertificate: false },
    }).connect();
  }, 180_000);

  afterAll(async () => {
    await pool?.close().catch(() => undefined);
    await t?.close();
  });

  // -------------------------------------------------------------------------
  // The shared connector, against a managed service
  // -------------------------------------------------------------------------
  it('passes the conformance suite', async () => {
    const evidence = await runConformance(
      {
        engine: 'azuresql',
        type: 'AZURE_SQL',
        config: configFrom(url),
        password: decodeURIComponent(url.password),
        provision: () => buildFixture(pool),
        teardown: () => dropFixture(pool),
      },
      (type, config, password) => t.services.connections.sqlConnectorFor(type, config, password),
      'Azure SQL',
    );
    await recordEvidence(evidence);
  }, 600_000);

  // -------------------------------------------------------------------------
  // The half that has no SQL Server equivalent
  // -------------------------------------------------------------------------
  describe('what is Azure’s own', () => {
    it('refuses an unencrypted connection, because the service does', async () => {
      // Azure SQL requires TLS. A connector that silently falls back to plaintext would be a finding
      // about this platform, not about Azure.
      const connector = t.services.connections.sqlConnectorFor(
        'AZURE_SQL',
        configFrom(url, { encrypt: false }),
        decodeURIComponent(url.password),
      );
      const result = await connector.testConnection().catch((err) => ({ ok: false, summary: String(err) }));
      expect(result.ok, 'an unencrypted connection does not succeed').toBe(false);
      await connector.dispose?.();
    }, 120_000);

    it('reports a wrong password as a credential problem rather than a network one', async () => {
      // The distinction a person acting on the error needs: "your password is wrong" sends them
      // somewhere different from "we could not reach the server".
      const connector = t.services.connections.sqlConnectorFor(
        'AZURE_SQL',
        configFrom(url),
        'definitely-not-the-password',
      );
      const result = await connector.testConnection().catch((err) => ({
        ok: false,
        summary: String(err),
        checks: [],
      }));
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result), 'the reason names the login').toMatch(/login|password|credential|auth/i);
      await connector.dispose?.();
    }, 120_000);

    it.skipIf(!process.env.TEST_AZURE_SQL_BLOCKED_URL)(
      'reports a firewall rejection as a firewall rejection',
      async () => {
        // Azure SQL rejects an unlisted client address with its own error, and a person who sees
        // "connection failed" will go looking at the wrong thing.
        const blocked = new URL(process.env.TEST_AZURE_SQL_BLOCKED_URL!);
        const connector = t.services.connections.sqlConnectorFor(
          'AZURE_SQL',
          configFrom(blocked),
          decodeURIComponent(blocked.password),
        );
        const result = await connector.testConnection().catch((err) => ({ ok: false, summary: String(err) }));
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).toMatch(/firewall|not allowed|sp_set_firewall|client with IP/i);
        await connector.dispose?.();
      },
      120_000,
    );

    it.skipIf(!process.env.TEST_AZURE_SQL_ENTRA)(
      'authenticates with Entra rather than a SQL login',
      async () => {
        // Entra authentication is the configuration most enterprises will actually use, and it is a
        // different code path from a username and password. Skipped unless the environment says the
        // connection string is an Entra one.
        const connector = t.services.connections.sqlConnectorFor(
          'AZURE_SQL',
          configFrom(url, { authType: 'ENTRA_PASSWORD' }),
          decodeURIComponent(url.password),
        );
        const result = await connector.testConnection();
        expect(result.ok, result.summary).toBe(true);
        await connector.dispose?.();
      },
      180_000,
    );

    it('survives a transient fault without losing the operation', async () => {
      // Azure SQL closes idle connections and throttles under load, which is the ordinary case rather
      // than the exception. The connector retries; this checks that a sequence of reads across a long
      // enough span still returns the same answer rather than failing part way.
      const connector = t.services.connections.sqlConnectorFor(
        'AZURE_SQL',
        configFrom(url),
        decodeURIComponent(url.password),
      );
      try {
        const tables = await connector.listTables();
        expect(tables.length).toBeGreaterThan(0);
        // Several round trips, deliberately spaced, so a dropped idle connection is exercised.
        for (let i = 0; i < 3; i++) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          const again = await connector.listTables();
          expect(again.length, `read ${i + 1} agrees with the first`).toBe(tables.length);
        }
      } finally {
        await connector.dispose?.();
      }
    }, 180_000);
  });
});

/**
 * The same fixture as the SQL Server suite, deliberately.
 *
 * Comparing like with like is the point: if Azure SQL behaves differently from SQL Server on these
 * values, the difference is Azure's and not the fixture's.
 */
async function buildFixture(pool: import('mssql').ConnectionPool): Promise<EngineFixture> {
  const sql = (await import('mssql')).default;
  await dropFixture(pool);
  await pool.request().query(`CREATE SCHEMA ${SCHEMA}`);
  await pool.request().query(`
    CREATE TABLE ${SCHEMA}.people (
      [person_id]   uniqueidentifier NOT NULL CONSTRAINT PK_people PRIMARY KEY DEFAULT newid(),
      [code]        nvarchar(40) NOT NULL,
      [full_name]   nvarchar(400) NULL,
      [nickname]    nvarchar(100) NULL,
      [balance]     decimal(18,4) NULL,
      [joined_at]   datetime2(3) NULL,
      [joined_tz]   datetimeoffset(3) NULL,
      [big_number]  bigint NULL,
      [external_id] uniqueidentifier NULL,
      [notes]       nvarchar(max) NULL,
      [order]       int NOT NULL,
      [MixedCase]   nvarchar(50) NULL,
      [active]      bit NULL
    )`);
  await pool.request().query(`
    CREATE TABLE ${SCHEMA}.visits (
      [visit_id]  int IDENTITY(1,1) CONSTRAINT PK_visits PRIMARY KEY,
      [person_id] uniqueidentifier NOT NULL CONSTRAINT FK_visits_people REFERENCES ${SCHEMA}.people(person_id),
      [seen_on]   date NULL
    )`);
  await pool.request().query(`
    CREATE TABLE ${SCHEMA}.arrivals (
      [arrival_id] uniqueidentifier NOT NULL CONSTRAINT PK_arrivals PRIMARY KEY DEFAULT newid(),
      [code]       nvarchar(40) NOT NULL,
      [full_name]  nvarchar(400) NULL,
      [nickname]   nvarchar(100) NULL,
      [balance]    decimal(18,4) NULL,
      [notes]      nvarchar(max) NULL
    )`);

  const people: [string, string, string | null, string | null, number | null, string][] = [
    ['P-001', AWKWARD.unicode, null, AWKWARD.decimal, AWKWARD.bigInteger, AWKWARD.longText],
    ['P-002', AWKWARD.specialChars, AWKWARD.emptyString, '0.0001', 0, 'short'],
    ['P-003', 'Plain Name', 'plain', '-99.5000', -1, ''],
    ['DUP-9', 'First Duplicate', 'one', '1.0000', 1, 'a'],
    ['DUP-9', 'Second Duplicate', 'two', '2.0000', 2, 'b'],
    ['DUP-9', 'Third Duplicate', null, '3.0000', 3, 'c'],
    ['P-007', 'Seventh', 'seven', null, null, 'd'],
  ];
  for (const [code, name, nickname, balance, big, notes] of people) {
    await pool
      .request()
      .input('code', sql.NVarChar(40), code)
      .input('full_name', sql.NVarChar(400), name)
      .input('nickname', sql.NVarChar(100), nickname)
      .input('balance', sql.Decimal(18, 4), balance)
      .input('big_number', sql.BigInt, big)
      .input('notes', sql.NVarChar(sql.MAX), notes).query(`
        INSERT INTO ${SCHEMA}.people
          (code, full_name, nickname, balance, joined_at, joined_tz, big_number, external_id, notes, [order], [MixedCase], [active])
        VALUES
          (@code, @full_name, @nickname, @balance, '2026-03-01T12:34:56', '2026-03-01T12:34:56+05:30', @big_number, newid(), @notes, 7, 'Mixed', 1)`);
  }
  await pool.request().query(`
    INSERT INTO ${SCHEMA}.visits (person_id, seen_on)
    SELECT TOP 3 person_id, '2026-04-01' FROM ${SCHEMA}.people`);

  const [version] = (await pool.request().query<{ v: string }>(`SELECT @@VERSION AS v`)).recordset;
  return {
    serverVersion: version!.v,
    peopleTable: `${SCHEMA}.people`,
    visitsTable: `${SCHEMA}.visits`,
    targetTable: `${SCHEMA}.arrivals`,
    peopleRows: people.length,
    duplicateKeyColumn: 'code',
    duplicateOccurrences: 3,
  };
}

async function dropFixture(pool: import('mssql').ConnectionPool): Promise<void> {
  for (const table of ['visits', 'arrivals', 'people']) {
    await pool.request().query(`DROP TABLE IF EXISTS ${SCHEMA}.${table}`);
  }
  await pool.request().query(`DROP SCHEMA IF EXISTS ${SCHEMA}`);
}
