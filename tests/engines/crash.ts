import { expect } from 'vitest';
import type { SqlConnectionConfig, SqlConnectionType } from '../../shared/domain';
import type { MigrationConnector } from '../../server/src/connectors/types';
import { DataverseError } from '../../server/src/dataverse/errors';
import { verdictOf } from '../../shared/write-state';

/**
 * The crash-consistency protocol against a real database.
 *
 * `tests/integration/crash-matrix.test.ts` proves the protocol through the engine, against the
 * simulated target. What it cannot prove is how a real server behaves at the boundary: whether an
 * insert that times out committed, whether a repeat collides with a constraint, what the driver reports.
 * Those are the facts the protocol rests on and they belong to PostgreSQL, MySQL and SQL Server rather
 * than to this platform.
 *
 * **What is simulated and what is real.** The process does not die — there is no way to kill a Node
 * process mid-statement inside CI and still assert anything afterwards. What is real: the server, the
 * driver, the statements, the constraints, the committed rows and the counts. What is simulated: the
 * *moment* of the failure, by having the test stop after a write rather than continuing. The question
 * each case answers is the one that matters at that boundary — "if we repeat this, what does the server
 * do?" — and the answer comes from the server.
 *
 * Every assertion about what is in the target is made with an independent query through the raw driver,
 * never through the connector that wrote it.
 */

export interface CrashTarget {
  engine: string;
  type: SqlConnectionType;
  config: SqlConnectionConfig;
  password: string;
  /** Creates a table with a target-assigned key and a unique business key, and one without. */
  provision: () => Promise<CrashFixture>;
  teardown: () => Promise<void>;
  /** Counts rows matching a business key, through the raw driver. */
  countByKey: (table: string, key: string) => Promise<number>;
  /** Total rows, through the raw driver. */
  countAll: (table: string) => Promise<number>;
}

export interface CrashFixture {
  /** Target-assigned key, with a UNIQUE constraint on `code`. */
  keyedTable: string;
  /** Target-assigned key, no unique constraint anywhere. */
  unkeyedTable: string;
}

export async function runCrashConformance(
  target: CrashTarget,
  connectorFor: (
    type: SqlConnectionType,
    config: SqlConnectionConfig,
    password: string,
  ) => MigrationConnector,
): Promise<{ engine: string; notes: string[] }> {
  const notes: string[] = [];
  const fixture = await target.provision();
  const connector = connectorFor(target.type, target.config, target.password);

  try {
    const keyed = await connector.getTable(fixture.keyedTable);
    const unkeyed = await connector.getTable(fixture.unkeyedTable);

    // =======================================================================
    // 1. A write that committed is findable by its business key
    // =======================================================================
    /**
     * The fact reconciliation depends on, asked of the server.
     *
     * After a write whose answer was lost, recovery looks for the record by its business key. If the
     * server does not return it, every recovery decision after that is wrong.
     */
    const id = await connector.createRecord(
      keyed,
      { values: { code: 'CRASH-1', full_name: 'Committed before the answer was lost' } },
      WRITE_OPTIONS,
    );
    expect(id, `${target.engine}: the insert returned a key`).toBeTruthy();
    expect(
      await target.countByKey(fixture.keyedTable, 'CRASH-1'),
      `${target.engine}: and the row is really there, counted by the driver`,
    ).toBe(1);

    const found = await connector.findByFields(keyed, { code: 'CRASH-1' }, ['code'], 2);
    expect(found.length, `${target.engine}: recovery finds it by its business key`).toBe(1);
    expect(found[0]!.id.toLowerCase(), `${target.engine}: and the same record it wrote`).toBe(
      id.toLowerCase(),
    );
    notes.push('A committed row is findable by business key, which is what recovery relies on.');

    // =======================================================================
    // 2. Repeating that write is refused by the server, not by us
    // =======================================================================
    /**
     * Why a unique key is the strongest recovery path.
     *
     * If the protocol ever did repeat a write, the server itself stops a duplicate — and reports it as a
     * conflict, which `verdictOf` classifies as a definite rejection rather than an unknown. That is the
     * difference between "the record is already there" and "we have no idea".
     */
    let duplicateError: unknown = null;
    try {
      await connector.createRecord(
        keyed,
        { values: { code: 'CRASH-1', full_name: 'The same record a second time' } },
        WRITE_OPTIONS,
      );
    } catch (err) {
      duplicateError = err;
    }
    expect(duplicateError, `${target.engine}: the server refuses a second copy`).toBeTruthy();
    const code = duplicateError instanceof DataverseError ? duplicateError.code : 'UNKNOWN';
    expect(
      verdictOf(code),
      `${target.engine}: and the refusal is definite, not ambiguous (got ${code})`,
    ).toBe('REJECTED');
    expect(
      await target.countByKey(fixture.keyedTable, 'CRASH-1'),
      `${target.engine}: still exactly one row`,
    ).toBe(1);
    notes.push(
      `A repeated insert on a unique key is refused as ${code}, which is classified as a definite rejection.`,
    );

    // =======================================================================
    // 3. Without a unique key the server cannot help, which is why we stop
    // =======================================================================
    /**
     * The case the protocol refuses to automate, demonstrated rather than asserted.
     *
     * Two identical inserts into a table with no unique constraint both succeed. Nothing in the server
     * prevents it and nothing in the rows distinguishes them — so after a lost answer there is no query
     * that could tell whether the first one committed. This is the evidence for
     * `RECONCILIATION_REQUIRED`.
     */
    const before = await target.countAll(fixture.unkeyedTable);
    await connector.createRecord(unkeyed, { values: { label: 'indistinguishable' } }, WRITE_OPTIONS);
    await connector.createRecord(unkeyed, { values: { label: 'indistinguishable' } }, WRITE_OPTIONS);
    const after = await target.countAll(fixture.unkeyedTable);
    expect(after - before, `${target.engine}: both inserts succeeded; nothing stopped the second`).toBe(2);
    const ambiguous = await connector.findByFields(unkeyed, { label: 'indistinguishable' }, ['label'], 5);
    expect(
      ambiguous.length,
      `${target.engine}: and a query cannot tell them apart, which is why recovery stops`,
    ).toBeGreaterThan(1);
    notes.push(
      'Two identical inserts into a table with no unique key both succeed and cannot be told apart afterwards. This is why no-evidence records stop for a person.',
    );

    // =======================================================================
    // 4. A repeated update is harmless, which is why updates recover themselves
    // =======================================================================
    await connector.updateRecord(keyed, id, { values: { full_name: 'Updated once' } }, WRITE_OPTIONS);
    await connector.updateRecord(keyed, id, { values: { full_name: 'Updated once' } }, WRITE_OPTIONS);
    const [afterUpdates] = await connector.retrieveByIds(keyed, [id], ['code', 'full_name']);
    expect(
      afterUpdates!.values['full_name'],
      `${target.engine}: the same update twice leaves the same value`,
    ).toBe('Updated once');
    expect(await target.countAll(fixture.keyedTable), `${target.engine}: and created no extra row`).toBe(1);
    notes.push('Repeating an update is idempotent, which is why an interrupted update is retried.');

    // =======================================================================
    // 5. An update to a row that is not there does not create one
    // =======================================================================
    /**
     * The asymmetry stated the other way.
     *
     * Recovery treats an interrupted update as safe to repeat. That is only true if a repeat cannot
     * invent a record, so the connector's update must be keyed and must not upsert. Asked of the server
     * rather than assumed from the SQL.
     */
    /**
     * An identifier of the right shape that cannot exist.
     *
     * Derived from the real key rather than hard-coded: the key is a uuid on one engine and a bigint on
     * another, and a malformed identifier would be rejected for the wrong reason — which would make this
     * check pass while proving nothing.
     */
    const ghost = /^\d+$/.test(id) ? '9999999999' : '00000000-0000-4000-8000-00000000dead';
    let ghostError: unknown = null;
    try {
      await connector.updateRecord(
        keyed,
        ghost,
        { values: { full_name: 'should not appear' } },
        WRITE_OPTIONS,
      );
    } catch (err) {
      ghostError = err;
    }
    expect(
      await target.countAll(fixture.keyedTable),
      `${target.engine}: updating a missing row created nothing`,
    ).toBe(1);
    notes.push(
      ghostError
        ? 'Updating a row that does not exist is refused rather than creating one.'
        : 'Updating a row that does not exist affects nothing and creates nothing.',
    );

    return { engine: target.engine, notes };
  } finally {
    await connector.dispose?.();
    await target.teardown();
  }
}

const WRITE_OPTIONS = {
  bypassCustomBusinessLogic: false,
  suppressFlowTriggers: false,
  impersonateUserId: null as string | null,
};
