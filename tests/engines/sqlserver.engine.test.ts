import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlConnectionConfig } from '../../shared/domain';
import { createTestApp, type TestApp } from '../helpers';
import { recordEvidence } from './evidence';
import { AWKWARD, runConformance, type EngineFixture } from './conformance';

/**
 * SQL Server, against an actual SQL Server.
 *
 * Every end-to-end journey in this repository that says "Legacy SQL Server" reaches a simulator
 * over the platform's own database. It exercises the planner and the engine thoroughly and proves
 * nothing whatever about SQL Server. This is the suite that does.
 *
 *   TEST_MSSQL_URL=sqlserver://sa:pw@localhost:1433/db npm run test:engines
 *
 * The fixture leans on the things that are SQL Server's own: bracketed identifiers, a non-dbo
 * schema, IDENTITY, uniqueidentifier, datetime2, nvarchar against varchar, and bit.
 */

const URL_VAR = 'TEST_MSSQL_URL';
const raw = process.env[URL_VAR];
const SCHEMA = 'dvm_conf';

describe.skipIf(!raw)('SQL Server conformance against a real server', () => {
  let t: TestApp;
  let pool: import('mssql').ConnectionPool;

  beforeAll(async () => {
    t = await createTestApp();
    const sql = (await import('mssql')).default;
    const url = new URL(raw!);
    pool = await new sql.ConnectionPool({
      server: url.hostname,
      port: Number(url.port) || 1433,
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      options: { encrypt: false, trustServerCertificate: true },
    }).connect();
  }, 180_000);

  afterAll(async () => {
    await pool?.close().catch(() => undefined);
    await t?.close();
  });

  it('drives the production connector through the mssql driver', async () => {
    const url = new URL(raw!);
    const config: SqlConnectionConfig = {
      host: url.hostname,
      port: Number(url.port) || 1433,
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
      authType: 'SQL_LOGIN',
      username: decodeURIComponent(url.username),
      encrypt: false,
      trustServerCertificate: true,
      transport: 'DIRECT',
      schemas: [SCHEMA],
    };

    const evidence = await runConformance(
      {
        type: 'SQL_SERVER',
        engine: 'sqlserver',
        config,
        password: decodeURIComponent(url.password),
        provision: () => provision(pool),
        teardown: () => teardown(pool),
      },
      (type, cfg, password) => t.services.connections.sqlConnectorFor(type, cfg, password),
      'tests/engines/sqlserver.engine.test.ts',
    );

    expect(evidence.capabilities.connect).toBe('PASSED');
    expect(evidence.capabilities.write).toBe('PASSED');
    expect(evidence.serverVersion, 'the server named itself').toMatch(/Microsoft SQL Server/i);
    await recordEvidence(evidence);
  }, 300_000);
});

async function teardown(pool: import('mssql').ConnectionPool) {
  for (const table of ['visits', 'arrivals', 'people']) {
    await pool
      .request()
      .query(`DROP TABLE IF EXISTS [${SCHEMA}].[${table}]`)
      .catch(() => undefined);
  }
  await pool
    .request()
    .query(`DROP SCHEMA IF EXISTS [${SCHEMA}]`)
    .catch(() => undefined);
}

/** The fixture, built with the raw driver before the connector sees any of it. */
async function provision(pool: import('mssql').ConnectionPool): Promise<EngineFixture> {
  const version = await pool.request().query<{ v: string }>('SELECT @@VERSION AS v');
  await teardown(pool);
  await pool.request().query(`CREATE SCHEMA [${SCHEMA}]`);
  // A non-dbo schema on purpose: a connector that assumes dbo discovers nothing here.
  await pool.request().query(`
    CREATE TABLE [${SCHEMA}].[people] (
      [person_id]   int IDENTITY(1,1) PRIMARY KEY,
      [code]        varchar(40) NOT NULL,
      [full_name]   nvarchar(200) NOT NULL,
      [nickname]    nvarchar(60) NULL,
      [balance]     decimal(18,4) NULL,
      [joined_at]   datetime2 NULL,
      [is_active]   bit NOT NULL DEFAULT 1,
      [big_number]  bigint NULL,
      [external_id] uniqueidentifier NULL,
      [notes]       nvarchar(max) NULL,
      [order]       int NULL,
      [MixedCase]   nvarchar(40) NULL
    )`);
  await pool.request().query(`
    CREATE TABLE [${SCHEMA}].[visits] (
      [visit_id]  int IDENTITY(1,1) PRIMARY KEY,
      [person_id] int NOT NULL,
      [seen_on]   date NOT NULL,
      CONSTRAINT [fk_dvm_visits_person] FOREIGN KEY ([person_id])
        REFERENCES [${SCHEMA}].[people]([person_id])
    )`);
  await pool.request().query(`
    CREATE TABLE [${SCHEMA}].[arrivals] (
      [arrival_id] int IDENTITY(1,1) PRIMARY KEY,
      [code]       varchar(40) NOT NULL,
      [full_name]  nvarchar(200) NOT NULL,
      [nickname]   nvarchar(60) NULL,
      [balance]    decimal(18,4) NULL,
      [notes]      nvarchar(max) NULL
    )`);

  const sql = (await import('mssql')).default;
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
      .input('code', sql.VarChar(40), code)
      // NVarChar deliberately: a varchar parameter would mangle the emoji on the way in and the
      // test would then be checking that we mangle consistently.
      .input('name', sql.NVarChar(200), name)
      .input('nickname', sql.NVarChar(60), nickname)
      .input('balance', sql.Decimal(18, 4), balance)
      .input('big', sql.BigInt, big)
      .input('notes', sql.NVarChar(sql.MAX), notes).query(`INSERT INTO [${SCHEMA}].[people]
                (code, full_name, nickname, balance, joined_at, big_number, external_id, notes, [order], [MixedCase])
              VALUES (@code, @name, @nickname, @balance, '2026-03-01T12:34:56', @big, NEWID(), @notes, 7, 'Mixed')`);
  }
  await pool.request().query(
    `INSERT INTO [${SCHEMA}].[visits] (person_id, seen_on)
     SELECT TOP (3) person_id, '2026-04-01' FROM [${SCHEMA}].[people]`,
  );

  return {
    serverVersion: String(version.recordset[0]!.v).split('\n')[0]!,
    peopleTable: `${SCHEMA}.people`,
    visitsTable: `${SCHEMA}.visits`,
    targetTable: `${SCHEMA}.arrivals`,
    peopleRows: people.length,
    duplicateKeyColumn: 'code',
    duplicateOccurrences: 3,
  };
}
