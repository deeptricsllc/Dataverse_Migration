import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlConnectionConfig } from '../../shared/domain';
import { createTestApp, type TestApp } from '../helpers';
import { recordEvidence } from './evidence';
import { AWKWARD, runConformance, type EngineFixture } from './conformance';

/**
 * MySQL, against an actual MySQL server.
 *
 * This connector has been the product's weakest claim since it was written — code complete, unit
 * tested, never pointed at the thing it was written for, and said so on the landing page. This is
 * the suite that changes that, or does not.
 *
 *   TEST_MYSQL_URL=mysql://root:pw@localhost:3306/db npm run test:engines
 *
 * MySQL calls a database what the others call a schema, so the fixture lives in its own database
 * and the tables are addressed unqualified, which is how the product's catalog names them.
 */

const URL_VAR = 'TEST_MYSQL_URL';
const raw = process.env[URL_VAR];

describe.skipIf(!raw)('MySQL conformance against a real server', () => {
  let t: TestApp;
  let conn: import('mysql2/promise').Connection;

  beforeAll(async () => {
    t = await createTestApp();
    const mysql = await import('mysql2/promise');
    conn = await mysql.createConnection({ uri: raw, multipleStatements: true });
  }, 120_000);

  afterAll(async () => {
    await conn?.end().catch(() => undefined);
    await t?.close();
  });

  it('drives the production connector through the mysql2 driver', async () => {
    const url = new URL(raw!);
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
      schemas: [],
    };

    const evidence = await runConformance(
      {
        type: 'MYSQL',
        engine: 'mysql',
        config,
        password: decodeURIComponent(url.password),
        provision: () => provision(conn, database),
        teardown: () => teardown(conn),
      },
      (type, cfg, password) => t.services.connections.sqlConnectorFor(type, cfg, password),
      'tests/engines/mysql.engine.test.ts',
    );

    expect(evidence.capabilities.connect).toBe('PASSED');
    expect(evidence.capabilities.write).toBe('PASSED');
    await recordEvidence(evidence);
  }, 300_000);
});

async function teardown(conn: import('mysql2/promise').Connection) {
  for (const table of ['dvm_visits', 'dvm_arrivals', 'dvm_people']) {
    await conn.query(`DROP TABLE IF EXISTS \`${table}\``).catch(() => undefined);
  }
}

/**
 * The fixture, built with the raw driver before the connector sees any of it.
 *
 * `utf8mb4` on every text column deliberately: MySQL's older `utf8` is three bytes and cannot hold
 * an emoji, so a connector tested against a `utf8` table would pass while silently mangling the
 * data a customer actually has.
 */
async function provision(
  conn: import('mysql2/promise').Connection,
  database: string,
): Promise<EngineFixture> {
  const [versionRows] = await conn.query<import('mysql2/promise').RowDataPacket[]>('SELECT VERSION() AS v');
  await teardown(conn);
  await conn.query(`
    CREATE TABLE dvm_people (
      person_id   INT AUTO_INCREMENT PRIMARY KEY,
      code        VARCHAR(40) NOT NULL,
      full_name   VARCHAR(200) CHARACTER SET utf8mb4 NOT NULL,
      nickname    VARCHAR(60) CHARACTER SET utf8mb4 NULL,
      balance     DECIMAL(18,4) NULL,
      joined_at   DATETIME NULL,
      joined_ts   TIMESTAMP NULL,
      is_active   TINYINT(1) NOT NULL DEFAULT 1,
      big_number  BIGINT NULL,
      unsigned_no INT UNSIGNED NULL,
      notes       LONGTEXT CHARACTER SET utf8mb4 NULL,
      \`order\`     INT NULL,
      \`MixedCase\` VARCHAR(40) NULL
    ) CHARACTER SET utf8mb4`);
  await conn.query(`
    CREATE TABLE dvm_visits (
      visit_id  INT AUTO_INCREMENT PRIMARY KEY,
      person_id INT NOT NULL,
      seen_on   DATE NOT NULL,
      CONSTRAINT fk_dvm_visits_person FOREIGN KEY (person_id) REFERENCES dvm_people(person_id)
    ) CHARACTER SET utf8mb4`);
  await conn.query(`
    CREATE TABLE dvm_arrivals (
      arrival_id INT AUTO_INCREMENT PRIMARY KEY,
      code       VARCHAR(40) NOT NULL,
      full_name  VARCHAR(200) CHARACTER SET utf8mb4 NOT NULL,
      nickname   VARCHAR(60) CHARACTER SET utf8mb4 NULL,
      balance    DECIMAL(18,4) NULL,
      notes      LONGTEXT CHARACTER SET utf8mb4 NULL
    ) CHARACTER SET utf8mb4`);

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
    await conn.execute(
      `INSERT INTO dvm_people (code, full_name, nickname, balance, joined_at, joined_ts, big_number, unsigned_no, notes, \`order\`, \`MixedCase\`)
       VALUES (?,?,?,?, '2026-03-01 12:34:56', '2026-03-01 12:34:56', ?, 4294967295, ?, 7, 'Mixed')`,
      [code, name, nickname, balance, big, notes],
    );
  }
  await conn.query(
    `INSERT INTO dvm_visits (person_id, seen_on)
     SELECT person_id, '2026-04-01' FROM dvm_people LIMIT 3`,
  );

  return {
    serverVersion: `MySQL ${String(versionRows[0]!['v'])}`,
    // MySQL calls a database what the others call a schema, and the product's catalog qualifies
    // table names with it. Matching the catalog rather than guessing is the point of the fixture.
    peopleTable: `${database}.dvm_people`,
    visitsTable: `${database}.dvm_visits`,
    targetTable: `${database}.dvm_arrivals`,
    peopleRows: people.length,
    duplicateKeyColumn: 'code',
    duplicateOccurrences: 3,
  };
}
