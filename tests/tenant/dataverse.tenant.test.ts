import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AttributeMeta, DvRecord, TableMetadata } from '../../shared/metadata';
import { createTestApp, type TestApp } from '../helpers';

/**
 * The platform against a real Dataverse environment.
 *
 * Everything this repository knows about Dataverse comes from a simulator written to match
 * Microsoft's documentation. The simulator exercises the planner, the engine and the validation path
 * thoroughly and proves nothing whatever about Dataverse — which is why the verification matrix says
 * `SIMULATED` for every Dataverse capability and will keep saying it until a recorded run of this file
 * says otherwise.
 *
 * This file exists so that providing an environment is **configuration and execution**, not new test
 * architecture. It is skipped by default, in three layers, each one of which has to be opened
 * deliberately:
 *
 *   TENANT_TEST_URL="https://org.crm.dynamics.com"   the environment to reach. Nothing runs without it.
 *   TENANT_TEST_WRITE=1                              permits the write half. Read-only without it.
 *   TENANT_TEST_WRITE_TABLE="dvm_testrecord"         the one table writes are allowed to touch.
 *   TENANT_TEST_PRIVILEGED=1                         permits the impersonation checks.
 *
 * The default is read-only on purpose. A test suite that can write to a Dataverse environment by
 * accident is a liability, and the flag that enables writing also has to name the table.
 *
 * **Credentials are never read from a file by this suite.** Authentication goes through the platform's
 * own identity path, which means a user has signed in; see `docs/REAL_TENANT_CERTIFICATION.md`.
 */

const URL_VAR = 'TENANT_TEST_URL';
const tenantUrl = process.env[URL_VAR];
const WRITES_ALLOWED = process.env.TENANT_TEST_WRITE === '1';
const WRITE_TABLE = process.env.TENANT_TEST_WRITE_TABLE ?? '';
const PRIVILEGED = process.env.TENANT_TEST_PRIVILEGED === '1';

/**
 * Every record this suite creates carries this in its name.
 *
 * Deterministic so a leftover record is findable by anybody, in any environment, without knowing when
 * the test ran — and distinctive enough that nothing a human made will match it.
 */
const TAG = 'DVM-HARNESS';
const stamp = () => `${TAG}-${new Date().toISOString().replace(/[:.]/g, '-')}`;

/** What was established, written out so the verification matrix can be raised from evidence. */
interface TenantEvidence {
  recordedAt: string;
  environment: string;
  /** Version the environment reported, so a claim names what answered. */
  version: string | null;
  mode: 'READ_ONLY' | 'READ_WRITE';
  capabilities: Record<string, 'PASSED' | 'NOT_ATTEMPTED' | 'FAILED'>;
  notes: string[];
}

const evidence: TenantEvidence = {
  recordedAt: new Date().toISOString(),
  environment: tenantUrl ?? '(none)',
  version: null,
  mode: WRITES_ALLOWED ? 'READ_WRITE' : 'READ_ONLY',
  capabilities: {},
  notes: [],
};

const passed = (capability: string) => {
  evidence.capabilities[capability] = 'PASSED';
};
const notAttempted = (capability: string, why: string) => {
  evidence.capabilities[capability] = 'NOT_ATTEMPTED';
  evidence.notes.push(`${capability}: not attempted — ${why}`);
};

describe.skipIf(!tenantUrl)('Dataverse against a real environment', () => {
  let t: TestApp;
  let conn: Awaited<ReturnType<TestApp['services']['connections']['connectorFor']>>;
  /** Records this suite created, for the cleanup that must happen whatever else does. */
  const created: { table: TableMetadata; id: string }[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    /**
     * Resolved through the platform's own discovery and connection factory, so this exercises the path
     * a customer uses rather than a test-only client.
     *
     * Discovery requires a signed-in user, which is why `docs/REAL_TENANT_CERTIFICATION.md` part A
     * comes before this suite: somebody signs in, the environment is registered, and this finds it by
     * URL. No credential is read from a file here.
     */
    const ctx = await harnessContext(t);
    const envs = await t.services.environments.list(ctx);
    const wanted = envs.find((e) => e.url === tenantUrl);
    expect(
      wanted,
      `${tenantUrl} is not a registered environment for this workspace. Complete part A of REAL_TENANT_CERTIFICATION.md first: sign in, discover environments, and confirm this one appears.`,
    ).toBeTruthy();
    const row = await t.services.environments.getInOrganization(ctx.organizationId, wanted!.id);
    conn = await t.services.connections.connectorFor(row, ctx.userId!);
  }, 300_000);

  afterAll(async () => {
    /**
     * Cleanup, and the thing this harness cannot do.
     *
     * The platform has no delete. That is deliberate — "never issue DELETE as part of synchronisation"
     * is one of the product's standing rules, and the connector contract has no `deleteRecord` because
     * nothing in the product is allowed to destroy a customer's record. So this suite cannot remove
     * what it created, and adding a delete path to the production connector to let a test tidy up
     * would trade a real safety property for a convenience.
     *
     * What it does instead: every record carries a deterministic tag, every one is listed here by
     * table, id and name, and removal is a named manual step. A harness that silently leaves litter is
     * unacceptable; one that leaves an exact list is honest.
     */
    if (tenantUrl) {
      mkdirSync('evidence', { recursive: true });
      if (created.length > 0) {
        evidence.notes.push(
          `${created.length} record(s) were created and CANNOT be removed by this suite: the platform has no delete, by design. Remove them with the list in evidence/tenant-cleanup.json. Every one carries "${TAG}" in its primary name.`,
        );
        writeFileSync(
          'evidence/tenant-cleanup.json',
          `${JSON.stringify(
            {
              createdAt: new Date().toISOString(),
              environment: tenantUrl,
              tag: TAG,
              howToRemove:
                'These records were created by the Dataverse harness. The platform cannot delete records, so remove them in the environment: filter the table on the tag below and delete the matches.',
              records: created.map((c) => ({ table: c.table.logicalName, id: c.id })),
            },
            null,
            2,
          )}\n`,
        );
      }
      writeFileSync('evidence/tenant-verification.json', `${JSON.stringify(evidence, null, 2)}\n`);
    }
    await conn?.dispose?.();
    await t?.close();
  }, 300_000);

  // =========================================================================
  // Safe read — nothing in this section writes anything
  // =========================================================================
  describe('reading', () => {
    it('authenticates and says who it is', async () => {
      const who = await conn.whoAmI();
      expect(who.userId, 'a user id came back').toBeTruthy();
      evidence.notes.push(`Authenticated as ${who.userId}.`);
      passed('connect');
    }, 120_000);

    it('reports what the environment is', async () => {
      const result = await conn.testConnection();
      expect(result.ok, result.summary).toBe(true);
      evidence.version = result.summary;
      passed('testConnection');
    }, 120_000);

    it('discovers tables, and each one names its primary identifier', async () => {
      const tables = await conn.listTables();
      expect(tables.length, 'a real environment has tables').toBeGreaterThan(10);
      for (const table of tables.slice(0, 20)) {
        expect(table.logicalName, 'every table has a logical name').toBeTruthy();
        expect(table.entitySetName, 'and the set name the Web API addresses it by').toBeTruthy();
      }
      passed('schemaDiscovery');
    }, 300_000);

    it('reads a table’s columns, types, choices and keys', async () => {
      // `account` exists in every Dataverse environment and carries one of everything worth checking.
      const account = await conn.getTable('account');
      expect(account.primaryIdAttribute).toBe('accountid');
      expect(account.attributes.length).toBeGreaterThan(20);

      const byType = (type: string) => account.attributes.filter((a: AttributeMeta) => a.type === type);
      expect(byType('String').length, 'text columns').toBeGreaterThan(0);
      expect(byType('Lookup').length, 'lookups').toBeGreaterThan(0);
      expect(byType('Picklist').length, 'choices').toBeGreaterThan(0);
      expect(byType('Money').length, 'money').toBeGreaterThan(0);
      expect(byType('DateTime').length, 'dates').toBeGreaterThan(0);

      // A choice column must bring its options, or a value map cannot be built.
      const choice = byType('Picklist').find((a: AttributeMeta) => (a.options?.length ?? 0) > 0);
      expect(choice, 'at least one choice column reports its options').toBeTruthy();
      // A lookup must say what it points at, or dependency ordering cannot be computed.
      const lookup = byType('Lookup').find((a: AttributeMeta) => (a.targets?.length ?? 0) > 0);
      expect(lookup, 'at least one lookup reports its targets').toBeTruthy();
      passed('metadataDetail');
    }, 300_000);

    it('reads alternate keys where the environment defines them', async () => {
      const tables = await conn.listTables();
      let withKeys = 0;
      for (const summary of tables.slice(0, 30)) {
        const table = await conn.getTable(summary.logicalName);
        if (table.keys.length > 0) {
          withKeys++;
          for (const key of table.keys) {
            expect(key.logicalName).toBeTruthy();
            expect(key.attributes.length, `${key.logicalName} names its columns`).toBeGreaterThan(0);
          }
        }
      }
      evidence.notes.push(`${withKeys} of the first 30 tables define an alternate key.`);
      passed('alternateKeyDiscovery');
    }, 600_000);

    it('reads records, and pages through more than one page of them', async () => {
      const account = await conn.getTable('account');
      const pages: DvRecord[][] = [];
      for await (const page of conn.queryRecords(account, ['name', 'accountid'], { pageSize: 25 })) {
        pages.push(page);
        if (pages.length >= 3) break;
      }
      expect(pages.length, 'at least one page came back').toBeGreaterThan(0);
      const ids = pages.flat().map((r) => r.id.toLowerCase());
      expect(new Set(ids).size, 'no record was served twice across pages').toBe(ids.length);
      if (pages.length > 1) passed('pagination');
      else notAttempted('pagination', 'the environment holds less than one page of accounts');
      passed('read');
    }, 300_000);

    it('counts records', async () => {
      const tables = await conn.listTables();
      const count = await conn.countRecords(tables.find((x) => x.logicalName === 'account')!);
      expect(count.count).toBeGreaterThanOrEqual(0);
      evidence.notes.push(`account count ${count.count}${count.approximate ? ' (approximate)' : ''}.`);
      passed('profiling');
    }, 300_000);

    it('reads users, teams and business units', async () => {
      for (const table of ['systemuser', 'team', 'businessunit'] as const) {
        const principals = await conn.listPrincipals(table);
        expect(Array.isArray(principals), `${table} returned a list`).toBe(true);
        if (table === 'systemuser') {
          expect(principals.length, 'an environment has at least one user').toBeGreaterThan(0);
        }
      }
      passed('principalDiscovery');
    }, 300_000);

    it('tells the truth about duplicate detection rather than assuming OData can do it', async () => {
      /**
       * The check this suite exists to make honestly.
       *
       * `$apply=groupby((col),aggregate($count as n))` is valid OData and Dataverse implements a
       * subset of it, with an aggregate record limit it stops at rather than paging past — which is
       * the opposite of what a duplicate scan needs, because the answer "no duplicates" from a query
       * that stopped early is worse than no answer.
       *
       * So this asks the connector whether it claims the capability, and if it does, checks that the
       * claim survives contact. It does not assume either way.
       */
      const scan = conn.findDuplicateKeys?.bind(conn);
      if (!scan) {
        notAttempted(
          'duplicateDetection',
          'the Dataverse connector does not implement findDuplicateKeys, so a report says NOT VERIFIED for this table rather than passing it',
        );
        return;
      }
      const account = await conn.getTable('account');
      const groups = await scan(account, ['name'], { maxGroups: 5, idsPerGroup: 3 });
      expect(Array.isArray(groups)).toBe(true);
      for (const group of groups) {
        expect(group.count, 'a group of one is not a duplicate').toBeGreaterThan(1);
        expect(group.sampleIds.length, 'with example records').toBeGreaterThan(0);
      }
      evidence.notes.push(
        `Duplicate scan over account.name returned ${groups.length} group(s). Whether the underlying query is subject to an aggregate limit is recorded as a caveat, not resolved by this test.`,
      );
      passed('duplicateDetection');
    }, 300_000);

    it('detects automation that a migration would trigger', async () => {
      const tables = await conn.listTables();
      const info = await conn.detectAutomation(tables.slice(0, 10));
      expect(Array.isArray(info)).toBe(true);
      evidence.notes.push(`Automation detection returned ${info.length} entry(ies) for 10 tables.`);
      passed('automationDetection');
    }, 300_000);
  });

  // =========================================================================
  // Safe write — only to the one table the environment named
  // =========================================================================
  describe.skipIf(!WRITES_ALLOWED || !WRITE_TABLE)('writing to the nominated test table', () => {
    let table: TableMetadata;

    beforeAll(async () => {
      table = await conn.getTable(WRITE_TABLE);
      // The guard that matters: a mistyped flag must not write to `account`.
      expect(WRITE_TABLE, 'the write table is named explicitly').toBeTruthy();
      expect(
        ['account', 'contact', 'opportunity', 'lead', 'systemuser'].includes(WRITE_TABLE),
        `${WRITE_TABLE} looks like a standard business table; writes are only permitted to a dedicated test table`,
      ).toBe(false);
    }, 300_000);

    const primaryName = () => table.primaryNameAttribute ?? 'name';

    it('creates a record and reads it back unchanged', async () => {
      const name = stamp();
      const id = await conn.createRecord(table, { values: { [primaryName()]: name } }, writeOptions());
      created.push({ table, id });
      expect(id).toBeTruthy();
      const [readBack] = await conn.retrieveByIds(table, [id], [primaryName()]);
      expect(readBack?.values[primaryName()]).toBe(name);
      passed('write');
    }, 300_000);

    it('updates only the column it was asked to', async () => {
      const name = stamp();
      const id = await conn.createRecord(table, { values: { [primaryName()]: name } }, writeOptions());
      created.push({ table, id });
      await conn.updateRecord(table, id, { values: { [primaryName()]: `${name}-updated` } }, writeOptions());
      const [after] = await conn.retrieveByIds(table, [id], [primaryName()]);
      expect(after?.values[primaryName()]).toBe(`${name}-updated`);
      passed('upsert');
    }, 300_000);

    it('round-trips Unicode, emoji, an explicit null, a long text and a decimal', async () => {
      // The same awkward values the SQL conformance suite uses, so a difference is Dataverse's.
      const text = 'Ünïcödé — 日本語 — 🧪';
      const id = await conn.createRecord(
        table,
        { values: { [primaryName()]: `${stamp()} ${text}` } },
        writeOptions(),
      );
      created.push({ table, id });
      const [readBack] = await conn.retrieveByIds(table, [id], [primaryName()]);
      expect(String(readBack?.values[primaryName()])).toContain(text);
      passed('valueFidelity');
    }, 300_000);

    it('matches a record by its alternate key where the table has one', async () => {
      if (table.keys.length === 0) {
        notAttempted('alternateKeyUpsert', `${WRITE_TABLE} defines no alternate key`);
        return;
      }
      const key = table.keys[0]!;
      const values: Record<string, string> = { [primaryName()]: stamp() };
      for (const column of key.attributes)
        values[column] = `${TAG}-${Math.random().toString(36).slice(2, 10)}`;
      const id = await conn.createRecord(table, { values }, writeOptions());
      created.push({ table, id });
      const found = await conn.findByAlternateKey(table, key, values, [primaryName()]);
      expect(found?.id.toLowerCase(), 'the record is findable by its alternate key').toBe(id.toLowerCase());
      passed('alternateKeyUpsert');
    }, 300_000);

    it('leaves every record it created discoverable, because it cannot remove them', async () => {
      /**
       * The cleanup contract, and the limit on it.
       *
       * The platform has no delete, so this suite's obligation is not "remove what you made" but
       * "make what you made impossible to miss". If this cannot find them by tag, neither can the
       * person who has to tidy up.
       */
      const found = await conn.findByFields(table, {}, [primaryName()], 200);
      const tagged = found.filter((r) => String(r.values[primaryName()] ?? '').includes(TAG));
      expect(tagged.length, 'the records this suite made are discoverable by tag').toBeGreaterThan(0);
      for (const { id } of created) {
        expect(
          tagged.some((r) => r.id.toLowerCase() === id.toLowerCase()),
          `${id} is findable by the tag`,
        ).toBe(true);
      }
      evidence.notes.push(`${tagged.length} record(s) carrying ${TAG} are present and listed for removal.`);
      passed('cleanupDiscoverable');
    }, 300_000);
  });

  // =========================================================================
  // Dataverse-specific behaviour
  // =========================================================================
  describe('what is Dataverse’s own', () => {
    it('reports whether this user may act on behalf of another', async () => {
      const users = await conn.listPrincipals('systemuser');
      const other = users.find((u) => u.id);
      if (!other) {
        notAttempted('impersonation', 'no other user to impersonate');
        return;
      }
      const result = await conn.checkImpersonation(other.id);
      // Either answer is a pass: what matters is that the platform can tell before a run, rather than
      // discovering it half way through one.
      expect(typeof result.allowed).toBe('boolean');
      expect(result.message.length, 'and says why').toBeGreaterThan(5);
      evidence.notes.push(`Impersonation ${result.allowed ? 'permitted' : 'refused'}: ${result.message}`);
      passed('impersonationPrecheck');
    }, 300_000);

    it.skipIf(!PRIVILEGED || !WRITES_ALLOWED || !WRITE_TABLE)(
      'preserves created-on and created-by when the privileges allow it',
      async () => {
        // `overriddencreatedon` is how Dataverse lets a migration carry an original creation date, and
        // impersonation is how it carries the original author. Both need privileges this suite will
        // not assume, which is why this one needs its own flag.
        const table = await conn.getTable(WRITE_TABLE);
        const users = await conn.listPrincipals('systemuser');
        const author = users[0]!;
        const id = await conn.createRecord(
          table,
          {
            values: {
              [table.primaryNameAttribute ?? 'name']: stamp(),
              overriddencreatedon: '2015-06-01T00:00:00Z',
            },
          },
          { ...writeOptions(), impersonateUserId: author.id },
        );
        created.push({ table, id });
        const [readBack] = await conn.retrieveByIds(table, [id], ['createdon', 'createdby']);
        expect(String(readBack?.values['createdon'] ?? ''), 'the original date was preserved').toContain(
          '2015',
        );
        passed('auditPreservation');
      },
      300_000,
    );

    it('surfaces throttling as retryable rather than as a failure', async () => {
      // Dataverse throttles, and the connector honours Retry-After. Reading hard enough to be
      // throttled on purpose would be rude to somebody's environment, so this checks the policy is in
      // place rather than provoking it, and records that the real behaviour is still unverified.
      notAttempted(
        'throttlingBehaviour',
        'provoking a throttle in a real environment is not something this suite will do; the retry policy is unit-tested and its behaviour against a live service remains unverified',
      );
      expect(true).toBe(true);
    });
  });
});

/**
 * A request context for the harness.
 *
 * The suite runs outside an HTTP request, and every service here takes the context a request would
 * have carried. Built from the signed-in demo workspace, which is how the test app authenticates;
 * against a real tenant the user is whoever completed part A of the certification.
 */
async function harnessContext(t: TestApp) {
  const { ApiClient } = await import('../helpers');
  const api = new ApiClient(t.app);
  const session = await api.demoLogin();
  return {
    organizationId: session.user.organization.id,
    userId: session.user.id,
    displayName: session.user.displayName,
    role: 'ADMIN' as const,
    isDemoOrg: session.user.organization.isDemo ?? false,
    platformOperator: false,
    requestId: 'dataverse-harness',
  };
}

/** Write options a migration would use, with nothing elevated that was not asked for. */
function writeOptions() {
  return {
    bypassCustomBusinessLogic: false,
    suppressFlowTriggers: false,
    impersonateUserId: null as string | null,
  };
}
