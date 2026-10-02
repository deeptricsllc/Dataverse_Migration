import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { SqlConnectionConfig } from '../../shared/domain';
import { createTestApp, type TestApp } from '../helpers';
import { runCrashConformance, type CrashFixture } from './crash';

/**
 * The crash-consistency protocol, against real PostgreSQL, MySQL and SQL Server.
 *
 * Mocks are not enough for this P0. The protocol rests on facts about what a server does at the moment a
 * write's answer is lost — whether a repeat collides, what the driver reports, whether two identical
 * inserts are distinguishable afterwards — and those facts belong to the engines.
 *
 * Skipped unless the engine's URL is set, exactly like the other conformance suites:
 *
 *   TEST_POSTGRES_URL=postgres://... TEST_MYSQL_URL=mysql://... TEST_MSSQL_URL=sqlserver://... npm run test:engines
 *
 * Writes `evidence/crash-verification.json`, which the final report cites.
 */

const SCHEMA = 'dvm_crash';
const results: { engine: string; notes: string[] }[] = [];

afterAll(() => {
  if (results.length === 0) return;
  mkdirSync('evidence', { recursive: true });
  writeFileSync(
    'evidence/crash-verification.json',
    `${JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        proves:
          'What each engine does at the boundary the crash-consistency protocol depends on: that a committed row is findable by its business key, that a repeated insert on a unique key is refused as a definite rejection, that two identical inserts into a table with no unique key cannot be told apart afterwards, and that a repeated update is idempotent.',
        doesNotProve:
          'That the process surviving a real crash behaves identically. The process is not killed: the failure moment is simulated by stopping after a write. The server, the driver, the statements and the row counts are real, and every count is taken through the raw driver rather than through the connector that wrote it.',
        engines: results,
      },
      null,
      2,
    )}\n`,
  );
});

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------
describe.skipIf(!process.env.TEST_POSTGRES_URL)('crash consistency against real PostgreSQL', () => {
  let t: TestApp;
  let pool: import('pg').Pool;

  beforeAll(async () => {
    t = await createTestApp();
    const pg = (await import('pg')).default;
    pool = new pg.Pool({ connectionString: process.env.TEST_POSTGRES_URL });
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await t?.close();
  });

  it('behaves as the protocol assumes', async () => {
    const config: SqlConnectionConfig = {
      host: new URL(process.env.TEST_POSTGRES_URL!).hostname,
      port: Number(new URL(process.env.TEST_POSTGRES_URL!).port) || 5432,
      database: decodeURIComponent(new URL(process.env.TEST_POSTGRES_URL!).pathname.replace(/^\//, '')),
      authType: 'SQL_LOGIN',
      username: decodeURIComponent(new URL(process.env.TEST_POSTGRES_URL!).username),
      encrypt: false,
      trustServerCertificate: true,
      transport: 'DIRECT',
      schemas: [SCHEMA],
    };
    const result = await runCrashConformance(
      {
        engine: 'postgresql',
        type: 'POSTGRES',
        config,
        password: decodeURIComponent(new URL(process.env.TEST_POSTGRES_URL!).password),
        provision: async (): Promise<CrashFixture> => {
          await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
          await pool.query(`CREATE SCHEMA ${SCHEMA}`);
          await pool.query(`
            CREATE TABLE ${SCHEMA}.keyed (
              id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              code      text NOT NULL UNIQUE,
              full_name text
            )`);
          await pool.query(`
            CREATE TABLE ${SCHEMA}.unkeyed (
              id    bigserial PRIMARY KEY,
              label text
            )`);
          return { keyedTable: `${SCHEMA}.keyed`, unkeyedTable: `${SCHEMA}.unkeyed` };
        },
        teardown: async () => {
          await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
        },
        countByKey: async (table, key) => {
          const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM ${table} WHERE code = $1`,
            [key],
          );
          return Number(rows[0]!.n);
        },
        countAll: async (table) => {
          const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
          return Number(rows[0]!.n);
        },
      },
      (type, cfg, password) => t.services.connections.sqlConnectorFor(type, cfg, password),
    );
    results.push(result);
    expect(result.notes.length).toBeGreaterThan(3);
  }, 600_000);
});

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------
describe.skipIf(!process.env.TEST_MYSQL_URL)('crash consistency against real MySQL', () => {
  let t: TestApp;
  let conn: import('mysql2/promise').Connection;

  beforeAll(async () => {
    t = await createTestApp();
    const mysql = await import('mysql2/promise');
    conn = await mysql.createConnection(process.env.TEST_MYSQL_URL!);
  }, 180_000);

  afterAll(async () => {
    await conn?.end().catch(() => undefined);
    await t?.close();
  });

  it('behaves as the protocol assumes', async () => {
    const url = new URL(process.env.TEST_MYSQL_URL!);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const config: SqlConnectionConfig = {
      host: url.hostname,
      port: Number(url.port) || 3306,
      database,
      authType: 'SQL_LOGIN',
      username: decodeURIComponent(url.username),
      encrypt: false,
      trustServerCertificate: true,
      transport: 'DIRECT',
      schemas: [database],
    };
    const result = await runCrashConformance(
      {
        engine: 'mysql',
        type: 'MYSQL',
        config,
        password: decodeURIComponent(url.password),
        provision: async (): Promise<CrashFixture> => {
          await conn.query(`DROP TABLE IF EXISTS dvm_crash_keyed`);
          await conn.query(`DROP TABLE IF EXISTS dvm_crash_unkeyed`);
          await conn.query(`
            CREATE TABLE dvm_crash_keyed (
              id        char(36) NOT NULL PRIMARY KEY,
              code      varchar(100) NOT NULL UNIQUE,
              full_name varchar(400)
            )`);
          await conn.query(`
            CREATE TABLE dvm_crash_unkeyed (
              id    bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
              label varchar(200)
            )`);
          return { keyedTable: `${database}.dvm_crash_keyed`, unkeyedTable: `${database}.dvm_crash_unkeyed` };
        },
        teardown: async () => {
          await conn.query(`DROP TABLE IF EXISTS dvm_crash_keyed`);
          await conn.query(`DROP TABLE IF EXISTS dvm_crash_unkeyed`);
        },
        countByKey: async (table, key) => {
          const [rows] = await conn.query(`SELECT count(*) AS n FROM ${table} WHERE code = ?`, [key]);
          return Number((rows as { n: number }[])[0]!.n);
        },
        countAll: async (table) => {
          const [rows] = await conn.query(`SELECT count(*) AS n FROM ${table}`);
          return Number((rows as { n: number }[])[0]!.n);
        },
      },
      (type, cfg, password) => t.services.connections.sqlConnectorFor(type, cfg, password),
    );
    results.push(result);
    expect(result.notes.length).toBeGreaterThan(3);
  }, 600_000);
});

// ---------------------------------------------------------------------------
// SQL Server
// ---------------------------------------------------------------------------
describe.skipIf(!process.env.TEST_MSSQL_URL)('crash consistency against real SQL Server', () => {
  let t: TestApp;
  let pool: import('mssql').ConnectionPool;

  beforeAll(async () => {
    t = await createTestApp();
    const sql = (await import('mssql')).default;
    const url = new URL(process.env.TEST_MSSQL_URL!);
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

  it('behaves as the protocol assumes', async () => {
    const url = new URL(process.env.TEST_MSSQL_URL!);
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
    const result = await runCrashConformance(
      {
        engine: 'sqlserver',
        type: 'SQL_SERVER',
        config,
        password: decodeURIComponent(url.password),
        provision: async (): Promise<CrashFixture> => {
          for (const table of ['keyed', 'unkeyed']) {
            await pool.request().query(`DROP TABLE IF EXISTS ${SCHEMA}.${table}`);
          }
          await pool.request().query(`DROP SCHEMA IF EXISTS ${SCHEMA}`);
          await pool.request().query(`CREATE SCHEMA ${SCHEMA}`);
          await pool.request().query(`
            CREATE TABLE ${SCHEMA}.keyed (
              [id]        uniqueidentifier NOT NULL CONSTRAINT PK_crash_keyed PRIMARY KEY DEFAULT newid(),
              [code]      nvarchar(100) NOT NULL CONSTRAINT UQ_crash_code UNIQUE,
              [full_name] nvarchar(400) NULL
            )`);
          await pool.request().query(`
            CREATE TABLE ${SCHEMA}.unkeyed (
              [id]    bigint IDENTITY(1,1) CONSTRAINT PK_crash_unkeyed PRIMARY KEY,
              [label] nvarchar(200) NULL
            )`);
          return { keyedTable: `${SCHEMA}.keyed`, unkeyedTable: `${SCHEMA}.unkeyed` };
        },
        teardown: async () => {
          for (const table of ['keyed', 'unkeyed']) {
            await pool.request().query(`DROP TABLE IF EXISTS ${SCHEMA}.${table}`);
          }
          await pool.request().query(`DROP SCHEMA IF EXISTS ${SCHEMA}`);
        },
        countByKey: async (table, key) => {
          const result = await pool
            .request()
            .input('code', key)
            .query<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE [code] = @code`);
          return Number(result.recordset[0]!.n);
        },
        countAll: async (table) => {
          const result = await pool.request().query<{ n: number }>(`SELECT count(*) AS n FROM ${table}`);
          return Number(result.recordset[0]!.n);
        },
      },
      (type, cfg, password) => t.services.connections.sqlConnectorFor(type, cfg, password),
    );
    results.push(result);
    expect(result.notes.length).toBeGreaterThan(3);
  }, 600_000);
});
