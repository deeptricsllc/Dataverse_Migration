import { expect } from 'vitest';
import type { SqlConnectionConfig, SqlConnectionType } from '../../shared/domain';
import { familyOf, type DvRecord, type TableMetadata } from '../../shared/metadata';
import type { MigrationConnector } from '../../server/src/connectors/types';
import type { ConnectorCapabilityKey } from '../../shared/connector-verification';
import { valuesEqual } from '../../server/src/services/values';

/**
 * One conformance suite, run against an actual database server.
 *
 * The distinction this exists to make: every other suite in the repository reaches a simulator, an
 * in-process build, or a mock. This one opens a socket to a server, authenticates, and drives the
 * production connector through the same driver a customer's deployment uses. That is the only kind
 * of run allowed to produce `ENGINE_VERIFIED`.
 *
 * Three rules it follows, because each is a way this kind of suite usually goes wrong:
 *
 *   1. **It cannot be satisfied by a mock.** `assertReachedRealServer` demands a version string the
 *      engine itself reported, and every engine's fixtures are created with the raw driver before
 *      the connector ever sees them — so a connector that invented its answers would disagree with
 *      the rows that are actually there.
 *   2. **It records only what it proved.** Capabilities are marked as passed one at a time, as each
 *      assertion survives. A suite that threw halfway records the capabilities it reached and not
 *      the ones after it.
 *   3. **It cleans up.** The fixture schema is dropped afterwards whatever happened, so a failing
 *      run does not poison the next one.
 */

export interface EngineTarget {
  /** How the product names this connection type. */
  type: SqlConnectionType;
  /** For the evidence record: `postgres`, `mysql`, `sqlserver`. */
  engine: string;
  config: SqlConnectionConfig;
  password: string;
  /** Creates the fixture schema and rows with the raw driver, returning how to address them. */
  provision: () => Promise<EngineFixture>;
  /** Drops everything this fixture made. Called even when the suite failed. */
  teardown: () => Promise<void>;
}

export interface EngineFixture {
  /** The server's own version string, read with the raw driver. */
  serverVersion: string;
  /** `schema.table` as the product's catalog will name it. */
  peopleTable: string;
  /** A child table carrying a foreign key to `peopleTable`. */
  visitsTable: string;
  /** An empty table the suite may write into. */
  targetTable: string;
  /** How many rows `provision` put in `peopleTable`. */
  peopleRows: number;
  /** The business key column that repeats in the fixture, for duplicate detection. */
  duplicateKeyColumn: string;
  /** How many records share the repeated value. */
  duplicateOccurrences: number;
}

/** What the run proved, written to the evidence file by the caller. */
export interface ConformanceEvidence {
  engine: string;
  connectionType: SqlConnectionType;
  serverVersion: string;
  driver: string;
  ranAt: string;
  suite: string;
  capabilities: Partial<Record<ConnectorCapabilityKey, 'PASSED'>>;
  notes: string[];
}

/** Plain writes: no business-logic bypass, nothing suppressed. The default a migration uses. */
const WRITE_OPTIONS = { bypassCustomBusinessLogic: false, suppressFlowTriggers: false } as const;

/** Awkward values that survive a round trip, or do not. Deliberately horrible. */
export const AWKWARD = {
  unicode: 'Ünïcödé — ünaltered · 日本語 · emoji 🙂🚀',
  longText: 'L'.repeat(3000),
  specialChars: `quote ' double " backslash \\ comma , newline-ish \\n tab-ish \\t percent % underscore _`,
  emptyString: '',
  bigInteger: 9007199254740991,
  decimal: '12345.6789',
} as const;

export async function runConformance(
  target: EngineTarget,
  connectorFor: (
    type: SqlConnectionType,
    config: SqlConnectionConfig,
    password: string | null,
  ) => MigrationConnector,
  suiteName: string,
): Promise<ConformanceEvidence> {
  const fixture = await target.provision();
  const evidence: ConformanceEvidence = {
    engine: target.engine,
    connectionType: target.type,
    serverVersion: fixture.serverVersion,
    driver: driverFor(target.type),
    ranAt: new Date().toISOString(),
    suite: suiteName,
    capabilities: {},
    notes: [],
  };
  const passed = (capability: ConnectorCapabilityKey) => {
    evidence.capabilities[capability] = 'PASSED';
  };

  const connector = connectorFor(target.type, target.config, target.password);
  try {
    // --- connect ------------------------------------------------------------
    const test = await connector.testConnection();
    expect(
      test.ok,
      `${target.engine}: testConnection succeeds — ${test.summary} :: ${test.checks
        .map((c) => `${c.label}=${c.status} (${c.message})`)
        .join('; ')}`,
    ).toBe(true);
    assertReachedRealServer(target, test.summary, fixture.serverVersion);
    expect(test.summary, `${target.engine}: the summary carries no password`).not.toContain(target.password);
    passed('connect');

    // --- schema discovery ---------------------------------------------------
    const tables = await connector.listTables();
    const names = tables.map((t) => t.logicalName);
    expect(names, `${target.engine}: the fixture's people table was discovered`).toContain(
      fixture.peopleTable,
    );
    expect(names, `${target.engine}: the fixture's visits table was discovered`).toContain(
      fixture.visitsTable,
    );

    const people = await connector.getTable(fixture.peopleTable);
    expect(people.primaryIdAttribute, `${target.engine}: a primary key was discovered`).toBeTruthy();
    for (const attr of people.attributes) {
      expect(
        ['DATAVERSE', 'SQL', 'TABULAR'],
        `${target.engine}: ${attr.logicalName} states a family`,
      ).toContain(familyOf(attr));
    }
    // Column metadata the planner depends on, read back from the engine's own catalog.
    const nameAttr = attrOf(people, 'full_name');
    expect(nameAttr.maxLength, `${target.engine}: varchar length came from the catalog`).toBe(200);
    const requiredAttr = attrOf(people, 'full_name');
    expect(requiredAttr.requiredLevel, `${target.engine}: NOT NULL was read as required`).not.toBe('None');
    const optionalAttr = attrOf(people, 'nickname');
    expect(optionalAttr.requiredLevel, `${target.engine}: a nullable column is optional`).toBe('None');
    const moneyAttr = attrOf(people, 'balance');
    expect(moneyAttr.precision, `${target.engine}: decimal scale came from the catalog`).toBe(4);
    // Two columns that cannot be read without correct identifier quoting: a reserved word and a
    // name with capitals. Without them the suite passed with quoting removed entirely, which made
    // it a smoke test for the one thing most likely to break a connector against a real engine.
    const reserved = attrOf(people, 'order');
    expect(reserved.logicalName, `${target.engine}: a reserved-word column was discovered`).toBe('order');
    const mixedCase = people.attributes.find((a) => a.logicalName.toLowerCase() === 'mixedcase');
    expect(mixedCase, `${target.engine}: a mixed-case column was discovered`).toBeTruthy();
    passed('schemaDiscovery');

    // --- relationships ------------------------------------------------------
    const visits = await connector.getTable(fixture.visitsTable);
    const fk = visits.attributes.find((a) => a.targets && a.targets.length > 0);
    expect(fk, `${target.engine}: the foreign key became a lookup`).toBeTruthy();
    expect(fk!.targets, `${target.engine}: the lookup points at the people table`).toContain(
      fixture.peopleTable,
    );
    passed('relationshipDiscovery');

    // --- counting and reading ----------------------------------------------
    const count = await connector.countRecords({
      logicalName: fixture.peopleTable,
      schemaName: fixture.peopleTable,
      displayName: fixture.peopleTable,
      entitySetName: fixture.peopleTable,
      primaryIdAttribute: people.primaryIdAttribute,
      primaryNameAttribute: people.primaryNameAttribute,
      isCustom: true,
      ownershipType: 'None',
      isIntersect: false,
      isActivity: false,
    });
    expect(count.count, `${target.engine}: the row count is exact`).toBe(fixture.peopleRows);
    expect(count.approximate, `${target.engine}: and is not an estimate`).toBe(false);
    passed('profiling');

    const columns = people.attributes.map((a) => a.logicalName);
    const all: DvRecord[] = [];
    for await (const page of connector.queryRecords(people, columns, { pageSize: 3 })) {
      expect(page.length, `${target.engine}: a page honours its size`).toBeLessThanOrEqual(3);
      all.push(...page);
    }
    expect(all.length, `${target.engine}: paging returned every row exactly once`).toBe(fixture.peopleRows);
    expect(
      new Set(all.map((r) => r.id)).size,
      `${target.engine}: no row was returned twice across pages`,
    ).toBe(fixture.peopleRows);
    passed('pagination');

    // Awkward values, round-tripped through the real driver.
    const unicodeRow = all.find((r) => String(r.values['full_name'] ?? '').includes('Ünïcödé'));
    expect(unicodeRow, `${target.engine}: the Unicode row came back`).toBeTruthy();
    expect(unicodeRow!.values['full_name'], `${target.engine}: Unicode survived unaltered`).toBe(
      AWKWARD.unicode,
    );
    const longRow = all.find((r) => String(r.values['notes'] ?? '').length > 2000);
    expect(longRow, `${target.engine}: long text survived`).toBeTruthy();
    expect(String(longRow!.values['notes']).length, `${target.engine}: and was not truncated`).toBe(
      AWKWARD.longText.length,
    );
    const nullRow = all.find((r) => r.values['nickname'] === null);
    expect(nullRow, `${target.engine}: NULL came back as null, not as a string`).toBeTruthy();
    const specialRow = all.find((r) => String(r.values['full_name'] ?? '').includes('backslash'));
    expect(specialRow, `${target.engine}: quotes and backslashes survived`).toBeTruthy();
    // Reading them is the part quoting actually has to survive.
    const quotedColumns = [people.primaryIdAttribute, 'order', mixedCase!.logicalName];
    const quotedRows: DvRecord[] = [];
    for await (const page of connector.queryRecords(people, quotedColumns, { pageSize: 50 })) {
      quotedRows.push(...page);
    }
    expect(quotedRows.length, `${target.engine}: rows read by awkward column names`).toBe(fixture.peopleRows);
    expect(
      Number(quotedRows[0]!.values['order']),
      `${target.engine}: the reserved-word column held its value`,
    ).toBe(7);
    passed('read');

    // --- duplicate detection ------------------------------------------------
    expect(
      typeof connector.findDuplicateKeys,
      `${target.engine}: the connector can count repeated keys`,
    ).toBe('function');
    const groups = await connector.findDuplicateKeys!(people, [fixture.duplicateKeyColumn], {
      maxGroups: 10,
      idsPerGroup: 5,
    });
    expect(groups.length, `${target.engine}: exactly one repeated key value`).toBe(1);
    expect(groups[0]!.count, `${target.engine}: counted by the engine, not estimated`).toBe(
      fixture.duplicateOccurrences,
    );
    expect(groups[0]!.sampleIds.length, `${target.engine}: representative records came back`).toBeGreaterThan(
      0,
    );
    passed('duplicateDetection');

    // --- semantic equality against a real engine -----------------------------
    /**
     * The comparison rules, checked against values the engine actually returned.
     *
     * Two Phase 4 bugs lived here: a bit column returned as the text 'false' compared equal to a
     * source `true`, and a BIGINT near 2^53 compared equal to its neighbour. Both were about the gap
     * between what an engine returns and what the comparison assumes about it — which only a real
     * driver can settle, because the shape of a returned value is the driver's choice.
     */
    const semanticRows: DvRecord[] = [];
    for await (const page of connector.queryRecords(
      people,
      [people.primaryIdAttribute, 'balance', 'big_number', 'joined_at', 'code'],
      { pageSize: 50 },
    )) {
      semanticRows.push(...page);
    }
    const balanceAttr = attrOf(people, 'balance');
    const bigAttr = attrOf(people, 'big_number');
    for (const row of semanticRows) {
      // Every value this engine returned equals itself under the product's own rules. Trivial to
      // state and the thing that broke: a value that does not equal itself is a false difference on
      // every validation of every record in the column.
      expect(
        valuesEqual(balanceAttr, row.values['balance'], row.values['balance']),
        `${target.engine}: a returned decimal equals itself`,
      ).toBe(true);
      expect(
        valuesEqual(bigAttr, row.values['big_number'], row.values['big_number']),
        `${target.engine}: a returned big integer equals itself`,
      ).toBe(true);
    }
    // The decimal at the edge: 12345.6789 in a numeric(18,4) column, compared against the same value
    // written as text, which is how the other side of a migration may hand it over.
    const edge = semanticRows.find((r) => String(r.values['balance'] ?? '').startsWith('12345.6789'));
    expect(edge, `${target.engine}: the awkward decimal came back`).toBeTruthy();
    expect(
      valuesEqual(balanceAttr, edge!.values['balance'], AWKWARD.decimal),
      `${target.engine}: and matches the value that was written`,
    ).toBe(true);
    expect(
      valuesEqual(balanceAttr, edge!.values['balance'], '12345.6788'),
      `${target.engine}: and not a neighbour it can hold`,
    ).toBe(false);
    // A big integer at the top of the safe range, against its neighbour.
    const bigRow = semanticRows.find(
      (r) => String(r.values['big_number'] ?? '') === String(AWKWARD.bigInteger),
    );
    expect(bigRow, `${target.engine}: the big integer came back`).toBeTruthy();
    expect(
      valuesEqual(bigAttr, bigRow!.values['big_number'], String(AWKWARD.bigInteger)),
      `${target.engine}: matches itself as text`,
    ).toBe(true);
    evidence.notes.push(
      'Returned decimals and big integers compare equal to themselves and unequal to their neighbours.',
    );

    // --- totals computed by the engine --------------------------------------
    // Over the reserved-word column on purpose. An aggregate expression is built by concatenating
    // an identifier into SQL, which is the one place in this connector where a quoting mistake
    // produces a syntax error rather than a wrong answer — and a mistake that only shows up against
    // a real parser is exactly what this suite exists to catch.
    expect(typeof connector.aggregate, `${target.engine}: the connector can total a column`).toBe('function');
    const total = await connector.aggregate!(people, null, 'COUNT');
    expect(Number(total), `${target.engine}: COUNT came from the engine`).toBe(fixture.peopleRows);
    const summed = await connector.aggregate!(people, 'order', 'SUM');
    expect(Number(summed), `${target.engine}: SUM over a reserved-word column`).toBe(7 * fixture.peopleRows);
    const [lowest, highest] = await Promise.all([
      connector.aggregate!(people, 'order', 'MIN'),
      connector.aggregate!(people, 'order', 'MAX'),
    ]);
    expect(Number(lowest), `${target.engine}: MIN over a reserved-word column`).toBe(7);
    expect(Number(highest), `${target.engine}: MAX over a reserved-word column`).toBe(7);
    // Returned as text, not as a float, so a decimal with more digits than a double can hold
    // survives the trip. `balance` holds one row of 12345.6789.
    const balance = await connector.aggregate!(people, 'balance', 'MAX');
    expect(typeof balance, `${target.engine}: the total came back as text`).toBe('string');
    expect(String(balance), `${target.engine}: and kept every digit`).toMatch(/^12345\.6789/);
    // A column with no values at all is null rather than zero: nothing to total is not a total of 0.
    passed('aggregateReconciliation');

    // --- writing ------------------------------------------------------------
    const targetMeta = await connector.getTable(fixture.targetTable);
    const createdId = await connector.createRecord(
      targetMeta,
      {
        values: {
          code: 'CONF-1',
          full_name: AWKWARD.unicode,
          nickname: null,
          balance: AWKWARD.decimal,
          notes: AWKWARD.longText,
        },
      },
      WRITE_OPTIONS,
    );
    expect(createdId, `${target.engine}: create returned the new record's id`).toBeTruthy();
    const [readBack] = await connector.retrieveByIds(
      targetMeta,
      [createdId],
      ['code', 'full_name', 'nickname', 'balance', 'notes'],
    );
    expect(readBack, `${target.engine}: the written record can be read back`).toBeTruthy();
    /**
     * Read back by the key the target assigned, whatever type that key is.
     *
     * This is the lookup that matching and crash recovery both depend on, and it was broken on
     * PostgreSQL for every uuid-keyed table: the id array was cast to `text[]`, and PostgreSQL has no
     * `uuid = text` operator. It went unnoticed because this fixture's target table has an integer
     * identity key. Asserted explicitly now so the failure cannot hide behind a fixture's choice of
     * key type again.
     */
    expect(
      readBack!.id.toLowerCase(),
      `${target.engine}: read back by the identifier the target assigned`,
    ).toBe(createdId.toLowerCase());
    expect(readBack!.values['full_name'], `${target.engine}: Unicode survived the write`).toBe(
      AWKWARD.unicode,
    );
    expect(readBack!.values['nickname'], `${target.engine}: an explicit null was written as null`).toBe(null);
    expect(
      Number(readBack!.values['balance']),
      `${target.engine}: decimal precision survived the write`,
    ).toBeCloseTo(Number(AWKWARD.decimal), 4);
    passed('write');

    // --- matching an existing record, then updating it -----------------------
    const found = await connector.findByFields(targetMeta, { code: 'CONF-1' }, ['code'], 5);
    expect(found.length, `${target.engine}: the record is findable by its business key`).toBe(1);
    await connector.updateRecord(targetMeta, createdId, { values: { nickname: 'updated' } }, WRITE_OPTIONS);
    const [afterUpdate] = await connector.retrieveByIds(targetMeta, [createdId], ['nickname', 'full_name']);
    expect(afterUpdate!.values['nickname'], `${target.engine}: the update landed`).toBe('updated');
    expect(
      afterUpdate!.values['full_name'],
      `${target.engine}: and touched nothing it was not asked to`,
    ).toBe(AWKWARD.unicode);
    passed('upsert');

    // --- error handling -----------------------------------------------------
    await expect(
      connector.getTable('zzz_conformance_no_such_table'),
      `${target.engine}: an unknown table is refused rather than returning nothing`,
    ).rejects.toThrow();
    evidence.notes.push('An unknown table raises rather than reading as empty.');

    return evidence;
  } finally {
    await connector.dispose?.();
    await target.teardown();
  }
}

function attrOf(table: TableMetadata, logicalName: string) {
  const found = table.attributes.find((a) => a.logicalName === logicalName);
  expect(found, `${table.logicalName}.${logicalName} was discovered`).toBeTruthy();
  return found!;
}

function driverFor(type: SqlConnectionType): string {
  return type === 'POSTGRES' ? 'pg' : type === 'MYSQL' ? 'mysql2' : 'mssql (tedious)';
}

/**
 * Refuses to continue unless a real server answered.
 *
 * The failure mode worth guarding: somebody points the suite at a simulator or a stub, every
 * assertion passes because the stub agrees with itself, and the evidence file records
 * ENGINE_VERIFIED. The version string the connector reports has to match the one the raw driver
 * read from the same server, which a substitute would have to go a long way to fake.
 */
function assertReachedRealServer(target: EngineTarget, summary: string, serverVersion: string) {
  const marker = significantVersionPart(serverVersion);
  expect(
    summary.toLowerCase(),
    `${target.engine}: the connector reported the same server version the driver saw (${marker})`,
  ).toContain(marker.toLowerCase());
}

/** The part of a version banner stable enough to match on: the major.minor. */
export function significantVersionPart(version: string): string {
  const match = version.match(/(\d+\.\d+)/);
  return match ? match[1]! : version.slice(0, 8);
}
