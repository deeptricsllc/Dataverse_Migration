import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvironmentDto, SqlConnectionConfig, SqlConnectionType } from '../../shared/domain';
import { familyOf, type DvRecord, type TableMetadata } from '../../shared/metadata';
import type { MigrationConnector } from '../../server/src/connectors/types';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * One behavioural contract, applied to every connector.
 *
 * The platform treats connectors interchangeably — profiling, preflight, migration and validation all
 * call the same methods and rely on the same guarantees. Nothing until now asserted that two
 * connectors actually *behave* alike, so each was only as correct as its own tests, and a new one
 * could satisfy the TypeScript interface while breaking the assumptions everything downstream makes.
 *
 * It also changes what "untested" means for the drivers there is no embedded server for. Point an
 * environment variable at a real database and the same contract runs against it:
 *
 *   TEST_POSTGRES_URL=postgresql://user:pass@host:5432/db npm test
 *   TEST_MYSQL_URL=mysql://user:pass@host:3306/db npm test
 *   TEST_MSSQL_URL=sqlserver://user:pass@host:1433/db npm test
 *
 * So MySQL is not "unverifiable" — it is one variable away from verified, with the specification
 * already written. Read-only: nothing in this file writes to a source.
 */

interface Case {
  name: string;
  /** Built once per case. */
  connector: () => Promise<MigrationConnector>;
}

/** `postgresql://user:pass@host:5432/db?schemas=public,sales` into the platform's own config. */
function parseUrl(raw: string): { config: SqlConnectionConfig; type: SqlConnectionType } {
  const url = new URL(raw);
  const type: SqlConnectionType = url.protocol.startsWith('postgres')
    ? 'POSTGRES'
    : url.protocol.startsWith('mysql')
      ? 'MYSQL'
      : 'SQL_SERVER';
  const schemas = url.searchParams.get('schemas');
  return {
    type,
    config: {
      host: url.hostname,
      port: Number(url.port) || (type === 'POSTGRES' ? 5432 : type === 'MYSQL' ? 3306 : 1433),
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
      authType: 'SQL_LOGIN',
      username: decodeURIComponent(url.username),
      encrypt: url.searchParams.get('encrypt') !== 'false',
      trustServerCertificate: url.searchParams.get('trustServerCertificate') === 'true',
      transport: 'DIRECT',
      schemas: schemas
        ? schemas
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    },
  };
}

let t: TestApp;
let api: ApiClient;
let organizationId: string;
const cases: Case[] = [];

beforeAll(async () => {
  t = await createTestApp();
  api = new ApiClient(t.app);
  const session = await api.demoLogin();
  organizationId = session.user.organization.id;
  const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');

  const byName = (displayName: string) => envs.find((e) => e.displayName === displayName)!;
  const live = async (environmentId: string) => {
    const env = await t.services.environments.getInOrganization(organizationId, environmentId);
    return t.services.connections.connectorFor(env, 'contract-test', {});
  };

  // The connectors that exist in every checkout, so the contract always runs against something.
  cases.push({ name: 'demo Dataverse', connector: () => live(byName('DeepTrics Development').id) });
  cases.push({ name: 'demo SQL Server', connector: () => live(byName('Legacy SQL Server (Demo)').id) });

  // A staged source, built here so the contract covers the imported-file path too.
  const fileSource = await api.post<EnvironmentDto>(
    '/api/staged-sources',
    { displayName: 'Contract fixture', kind: 'UPLOAD' },
    201,
  );
  await api.post(`/api/staged-sources/${fileSource.id}/import`, {
    filename: 'contract.csv',
    contentBase64: Buffer.from(
      [
        'row_id,label,quantity',
        'R-1,Alpha,10',
        'R-2,Bravo,20',
        'R-3,Charlie,30',
        'R-4,Delta,40',
        'R-5,Echo,50',
      ].join('\n'),
      'utf8',
    ).toString('base64'),
  });
  cases.push({ name: 'imported file', connector: () => live(fileSource.id) });

  // Real servers, when somebody supplies one. The same contract, unchanged.
  for (const [variable, label] of [
    ['TEST_POSTGRES_URL', 'PostgreSQL (live)'],
    ['TEST_MYSQL_URL', 'MySQL (live)'],
    ['TEST_MSSQL_URL', 'SQL Server (live)'],
  ] as const) {
    const raw = process.env[variable];
    if (!raw) continue;
    const { config, type } = parseUrl(raw);
    const password = new URL(raw).password ? decodeURIComponent(new URL(raw).password) : null;
    cases.push({
      name: label,
      connector: async () => t.services.connections.sqlConnectorFor(type, config, password),
    });
  }
});

afterAll(async () => {
  await t.close();
});

describe('every connector satisfies the same contract', () => {
  it('has something to test against', () => {
    // If this ever finds only one connector, the suite has stopped being a contract.
    expect(cases.length).toBeGreaterThanOrEqual(3);
  });

  // `describe` bodies run before `beforeAll`, so the cases are resolved inside one test per
  // connector rather than by generating describes from a list that is still empty.
  it('holds for each of them', async () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const testCase of cases) {
      const connector = await testCase.connector();
      try {
        await assertContract(testCase.name, connector);
      } finally {
        await connector.dispose?.();
      }
    }
  }, 300_000);
});

/**
 * The contract itself.
 *
 * Every assertion carries the connector's name, so a failure says which one broke rather than only
 * what broke.
 */
async function assertContract(name: string, connector: MigrationConnector): Promise<void> {
  const where = (what: string) => `${name}: ${what}`;

  // --- discovery ------------------------------------------------------------
  const tables = await connector.listTables();
  expect(tables.length, where('listTables returns tables')).toBeGreaterThan(0);
  for (const summary of tables.slice(0, 20)) {
    expect(summary.logicalName, where('every table has a logical name')).toBeTruthy();
    expect(summary.displayName, where('every table has a display name')).toBeTruthy();
  }

  // A table with rows, found rather than assumed, so the contract needs no per-provider fixture.
  let meta: TableMetadata | null = null;
  let total = 0;
  for (const summary of tables.slice(0, 40)) {
    let candidate: TableMetadata;
    try {
      candidate = await connector.getTable(summary.logicalName);
    } catch {
      continue; // A table the login cannot describe is not a contract failure.
    }
    if (!candidate.primaryIdAttribute) continue;
    const count = await connector.countRecords(summary).catch(() => ({ count: 0, approximate: true }));
    if (count.count > 0) {
      meta = candidate;
      total = count.count;
      break;
    }
  }
  expect(meta, where('at least one readable table has rows')).not.toBeNull();
  const table = meta!;

  expect(table.attributes.length, where('metadata has attributes')).toBeGreaterThan(0);
  expect(table.primaryIdAttribute, where('metadata names a primary id')).toBeTruthy();
  // Every column must state which kind of system it came from: four places decide whether to convert
  // a value based on it, and a column that does not say is read as Dataverse.
  for (const attr of table.attributes) {
    expect(['DATAVERSE', 'SQL', 'TABULAR'], where(`${attr.logicalName} states a family`)).toContain(
      familyOf(attr),
    );
  }

  // A table that does not exist is an error, not an empty result — otherwise a typo in a plan reads
  // as a table with no rows and a migration silently does nothing.
  await expect(
    connector.getTable('zzz_contract_no_such_table'),
    where('an unknown table is refused'),
  ).rejects.toThrow();

  // --- reading --------------------------------------------------------------
  const readable = table.attributes
    .filter((a) => a.isValidForRead && !a.attributeOf && a.logicalName !== table.primaryIdAttribute)
    .slice(0, 8);
  // A strict subset on purpose. Asking for every column would make "returns nothing extra" vacuously
  // true, which is how a projection bug survives a green contract suite.
  const columns = readable.slice(0, Math.max(1, Math.min(2, readable.length - 1))).map((a) => a.logicalName);
  const omitted = readable.map((a) => a.logicalName).filter((c) => !columns.includes(c));

  const paged = await drain(connector, table, columns, 2);
  expect(paged.length, where('paging returns records')).toBeGreaterThan(0);
  for (const record of paged) {
    expect(record.id, where('every record has an id')).toBeTruthy();
    // Asking for specific columns must not return others: profiling and diffing both count on it.
    for (const key of Object.keys(record.values)) {
      expect(columns, where(`${key} was asked for`)).toContain(key);
    }
    for (const key of omitted) {
      expect(
        Object.keys(record.values),
        where(`${key} was not asked for and must not come back`),
      ).not.toContain(key);
    }
  }
  const ids = paged.map((r) => r.id.toLowerCase());
  expect(new Set(ids).size, where('no record is returned twice')).toBe(ids.length);

  // Paging must not change what is returned. A wrong keyset predicate shows up here and almost
  // nowhere else — it silently drops or repeats whole pages.
  const single = await drain(connector, table, columns, 1000);
  expect(
    new Set(single.map((r) => r.id.toLowerCase())),
    where('the same records however they are paged'),
  ).toEqual(new Set(ids));
  if (total <= 5000) {
    expect(paged.length, where('every record is read')).toBe(total);
  }

  // --- lookup by id ---------------------------------------------------------
  const wanted = paged.slice(0, 2).map((r) => r.id);
  const fetched = await connector.retrieveByIds(table, wanted, columns);
  expect(
    new Set(fetched.map((r) => r.id.toLowerCase())),
    where('retrieveByIds returns exactly what was asked for'),
  ).toEqual(new Set(wanted.map((w) => w.toLowerCase())));
  expect(await connector.retrieveByIds(table, [], columns), where('no ids means no records')).toEqual([]);

  // --- lookup by value ------------------------------------------------------
  const probe = findProbe(paged, columns);
  if (probe) {
    const found = await connector.findByFields(table, { [probe.field]: probe.value }, columns, 5);
    expect(
      found.some((r) => r.id.toLowerCase() === probe.recordId.toLowerCase()),
      where(`findByFields finds the record it was given (${probe.field})`),
    ).toBe(true);
    const limited = await connector.findByFields(table, { [probe.field]: probe.value }, columns, 1);
    expect(limited.length, where('findByFields respects its limit')).toBeLessThanOrEqual(1);
  }

  // --- incremental reads ----------------------------------------------------
  // A watermark column that does not exist must be refused. Falling back to a full read would make an
  // incremental schedule quietly expensive and its watermark meaningless.
  await expect(
    drain(connector, table, columns, 10, { field: 'zzz_no_such_column', value: '2020-01-01' }),
    where('an unknown watermark column is refused'),
  ).rejects.toThrow();

  // --- writing --------------------------------------------------------------
  if (!connector.capabilities.supportsWrite) {
    const options = { bypassCustomBusinessLogic: false, suppressFlowTriggers: false };
    await expect(
      connector.createRecord(table, { values: {} }, options),
      where('a read-only connector refuses a create'),
    ).rejects.toThrow();
    await expect(
      connector.updateRecord(table, paged[0].id, { values: {} }, options),
      where('a read-only connector refuses an update'),
    ).rejects.toThrow();
    // And says so, so nothing offers it as a target.
    expect(table.isView, where('a read-only source is marked as a view')).toBe(true);
  }
}

async function drain(
  connector: MigrationConnector,
  table: TableMetadata,
  columns: string[],
  pageSize: number,
  since?: { field: string; value: string },
): Promise<DvRecord[]> {
  const out: DvRecord[] = [];
  for await (const page of connector.queryRecords(table, columns, { pageSize, since })) {
    out.push(...page);
    // A contract test must not read a production table in full.
    if (out.length >= 5000) break;
  }
  return out;
}

/** A column and value that identify at least the record they came from, for findByFields. */
function findProbe(
  records: DvRecord[],
  columns: string[],
): { field: string; value: string | number | boolean; recordId: string } | null {
  for (const record of records) {
    for (const field of columns) {
      const value = record.values[field];
      if (value === null || value === undefined) continue;
      // Lookups and arrays are not scalar criteria, and an empty string matches too much to prove
      // anything.
      if (typeof value === 'object') continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      return { field, value, recordId: record.id };
    }
  }
  return null;
}
