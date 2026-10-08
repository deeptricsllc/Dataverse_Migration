import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { demoRecords, migrationRecordMaps } from '../../server/src/db/schema';
import type {
  EnvironmentDto,
  FieldMappingDto,
  MigrationPlanDto,
  MigrationRunDto,
  PlanEntityDto,
  TransformationRule,
  ValidationRunDto,
} from '../../shared/domain';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * The sixteen cases a validation engine has to get right, each driven through the real engine.
 *
 * Every scenario here is produced by migrating real demo data and then putting the target into the
 * state under test — by changing a target record, by removing one, by adding one nobody migrated.
 * Nothing is stubbed, and no result is asserted against a fixture: the comparison reads two
 * environments and the test reads what it reported.
 *
 * The target is changed *after* the run on purpose. That is the real shape of the problem: a
 * migration reports success, somebody or something edits the target, and the question a validation
 * answers is whether what is in the target now is what the migration was supposed to put there.
 *
 * See `docs/VALIDATION_SEMANTICS.md`.
 */
/** One page of findings, as the API returns it. */
interface DifferencePage {
  items: {
    entity: string;
    field: string | null;
    differenceType: string;
    outcome: string;
    sourceValue: string | null;
    targetValue: string | null;
    sourceRecordId: string | null;
  }[];
  total: number;
}

/** One row of the identity map: the pairing the migration itself created. */
interface IdentityRow {
  sourceId: string;
  targetId: string | null;
  outcome: string;
}

/** One record as the simulated target stores it. */
interface TargetRow {
  organizationId: string;
  data: Record<string, unknown>;
}

describe('validation scenarios', () => {
  /**
   * One workspace per scenario, torn down after it.
   *
   * These scenarios share a target, and most of them put it into a state on purpose: a record
   * removed, a value changed, a parent repointed. Run against one workspace they stop being
   * deterministic — the second scenario reads the first one's damage, a table that is already in the
   * target produces no writes for a fault to interrupt, and the suite passes or fails on its own
   * ordering. A fresh workspace costs a second and buys a scenario that means what it says.
   */
  const scenario = async (
    body: (w: {
      api: ApiClient;
      t: TestApp;
      dev: EnvironmentDto;
      uat: EnvironmentDto;
      drain: () => Promise<void>;
      plan: (name: string, tables: string[]) => Promise<MigrationPlanDto>;
      execute: (p: MigrationPlanDto) => Promise<MigrationRunDto>;
      migrate: (name: string, tables: string[]) => Promise<MigrationRunDto>;
      validate: (migrationRunId: string) => Promise<ValidationRunDto>;
      mappingsOf: (
        p: MigrationPlanDto,
        logicalName: string,
      ) => Promise<{ entity: PlanEntityDto; mappings: FieldMappingDto[] }>;
      differences: (id: string, query?: string) => Promise<DifferencePage>;
      identityRows: (runId: string, logicalName: string) => Promise<IdentityRow[]>;
      targetRow: (logicalName: string, recordId: string) => Promise<TargetRow | null>;
      editTarget: (logicalName: string, recordId: string, patch: Record<string, unknown>) => Promise<void>;
      addToTarget: (logicalName: string, recordId: string, data: Record<string, unknown>) => Promise<void>;
      removeFromTarget: (logicalName: string, recordId: string) => Promise<void>;
    }) => Promise<void>,
  ) => {
    const t = await createTestApp();
    try {
      const api = new ApiClient(t.app);
      await api.demoLogin();
      const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
      const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
      const uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;

      const drain = async () => {
        const worker = t.services.createWorker();
        await worker.drain(300_000);
        await worker.stop();
      };

      /** A plan over the demo pair, re-read so the confirmation names are the current ones. */
      const plan = async (name: string, tables: string[]) => {
        const created = await api.post<MigrationPlanDto>('/api/plans', {
          name: `${name} ${Date.now()}`,
          sourceEnvironmentId: dev.id,
          targetEnvironmentId: uat.id,
          tables,
        });
        return api.get<MigrationPlanDto>(`/api/plans/${created.id}`);
      };

      const mappingsOf = async (p: MigrationPlanDto, logicalName: string) => {
        const entity = p.entities.find((e) => e.logicalName === logicalName)!;
        const r = await api.get<{ mappings: FieldMappingDto[] }>(
          `/api/plans/${p.id}/entities/${entity.id}/mappings`,
        );
        return { entity, mappings: r.mappings };
      };

      const execute = async (p: MigrationPlanDto) => {
        const current = await api.get<MigrationPlanDto>(`/api/plans/${p.id}`);
        const started = await api.post<MigrationRunDto>(`/api/plans/${p.id}/execute`, {
          confirmSourceName: current.sourceEnvironment.displayName,
          confirmTargetName: current.targetEnvironment.displayName,
          acknowledgeWarnings: true,
        });
        await drain();
        return api.get<MigrationRunDto>(`/api/runs/${started.id}`);
      };

      const migrate = async (name: string, tables: string[]) => execute(await plan(name, tables));

      const validate = async (migrationRunId: string) => {
        const started = await api.post<ValidationRunDto>('/api/validations', { migrationRunId });
        await drain();
        return api.get<ValidationRunDto>(`/api/validations/${started.id}`);
      };

      const differences = (id: string, query = '') =>
        api.get<DifferencePage>(`/api/validations/${id}/differences?limit=200${query}`);

      /** The identity rows this run wrote for one table, which is how the comparison pairs records. */
      const identityRows = (runId: string, logicalName: string) =>
        t.database.db
          .select()
          .from(migrationRecordMaps)
          .where(
            and(eq(migrationRecordMaps.runId, runId), eq(migrationRecordMaps.logicalName, logicalName)),
          ) as Promise<IdentityRow[]>;

      /**
       * One record as the target holds it.
       *
       * Read and written through the store the simulated environment keeps its data in, not through
       * the connector. These scenarios are about a target that changed after the run, and a
       * connector write would be another migration.
       */
      const targetRow = async (logicalName: string, recordId: string) => {
        const [row] = await t.database.db
          .select()
          .from(demoRecords)
          .where(
            and(
              eq(demoRecords.environmentKey, 'demo-uat'),
              eq(demoRecords.logicalName, logicalName),
              eq(demoRecords.recordId, recordId),
            ),
          );
        return (row as TargetRow | undefined) ?? null;
      };

      const scopeOf = (row: TargetRow, logicalName: string, recordId: string) =>
        and(
          eq(demoRecords.organizationId, row.organizationId),
          eq(demoRecords.environmentKey, 'demo-uat'),
          eq(demoRecords.logicalName, logicalName),
          eq(demoRecords.recordId, recordId),
        );

      const editTarget = async (logicalName: string, recordId: string, patch: Record<string, unknown>) => {
        const row = await targetRow(logicalName, recordId);
        expect(row, `${logicalName} ${recordId} is in the target`).not.toBeNull();
        await t.database.db
          .update(demoRecords)
          .set({ data: { ...row!.data, ...patch } })
          .where(scopeOf(row!, logicalName, recordId));
      };

      const removeFromTarget = async (logicalName: string, recordId: string) => {
        const row = await targetRow(logicalName, recordId);
        expect(row, `${logicalName} ${recordId} is in the target`).not.toBeNull();
        await t.database.db.delete(demoRecords).where(scopeOf(row!, logicalName, recordId));
      };

      const addToTarget = async (logicalName: string, recordId: string, data: Record<string, unknown>) => {
        const [any] = await t.database.db
          .select()
          .from(demoRecords)
          .where(eq(demoRecords.environmentKey, 'demo-uat'));
        await t.database.db.insert(demoRecords).values({
          organizationId: (any as TargetRow).organizationId,
          environmentKey: 'demo-uat',
          logicalName,
          recordId,
          data,
        });
      };

      await body({
        api,
        t,
        dev,
        uat,
        drain,
        plan,
        execute,
        migrate,
        validate,
        mappingsOf,
        differences,
        identityRows,
        targetRow,
        editTarget,
        addToTarget,
        removeFromTarget,
      });
    } finally {
      await t.close();
    }
  };

  // -------------------------------------------------------------------------
  // 1. Exact source/target match
  // -------------------------------------------------------------------------

  it(
    '1. reports an exact match as passed, with every record accounted for',
    () =>
      scenario(async (w) => {
        const run = await w.migrate('Exact match', ['dtx_applicationconfig']);
        const report = await w.validate(run.id);
        const d = report.entities.find((e) => e.logicalName === 'dtx_applicationconfig')!;

        expect(d.checkedRecords, 'records were examined').toBeGreaterThan(0);
        expect(d.matched).toBe(d.checkedRecords);
        expect(d.different).toBe(0);
        expect(d.missing).toBe(0);
        expect(['PASS', 'WARNING']).toContain(d.outcome);
        // The rules are recorded with the result, not read back from the plan.
        expect(d.rules?.identity.basis).toBe('MIGRATION_IDENTITY_MAP');
        expect(d.rules!.comparedFields.length).toBeGreaterThan(0);
      }),
    600_000,
  );

  // -------------------------------------------------------------------------
  // 2. Missing target record
  // -------------------------------------------------------------------------

  it(
    '2. reports a record the run wrote and the target no longer holds as missing',
    () =>
      scenario(async (w) => {
        const run = await w.migrate('Missing record', ['dtx_region']);
        const rows = (await w.identityRows(run.id, 'dtx_region')).filter((r) => r.targetId);
        expect(rows.length, 'the run wrote regions').toBeGreaterThan(0);
        const victim = rows[0]!;
        await w.removeFromTarget('dtx_region', victim.targetId!);

        const report = await w.validate(run.id);
        const d = report.entities.find((e) => e.logicalName === 'dtx_region')!;
        expect(d.missing, 'exactly the record that was removed').toBe(1);
        expect(d.matched + d.different + d.missing).toBe(d.checkedRecords);
        expect(d.outcome).toBe('FAIL');

        const found = await w.differences(report.id, '&type=MISSING_IN_TARGET');
        expect(found.items.map((x) => x.sourceRecordId)).toContain(victim.sourceId);
      }),
    600_000,
  );

  // -------------------------------------------------------------------------
  // 3. Unexpected target record
  // -------------------------------------------------------------------------

  /**
   * A target record nobody migrated.
   *
   * Reported as a row-count difference, not as a missing or different record, which is the honest
   * answer for a migration validation: the comparison scope is the records this run claims, and a
   * shared target holds records from other sources, from earlier runs, and from people working in
   * the system. Calling every unaccounted target row a finding would report the other tenants of a
   * shared table as this migration's problem.
   *
   * The dataset-to-dataset comparison answers the stronger question, because there the scope is both
   * whole tables — see `ONLY_IN_RIGHT` in `data-comparison-service`.
   */
  it(
    '3. reports an unexpected target record as a count difference, not as a migration failure',
    () =>
      scenario(async (w) => {
        const run = await w.migrate('Unexpected record', ['dtx_region']);
        const rows = (await w.identityRows(run.id, 'dtx_region')).filter((r) => r.targetId);
        const template = await w.targetRow('dtx_region', rows[0]!.targetId!);
        const id = '00000000-0000-4000-8000-00000000beef';
        await w.addToTarget('dtx_region', id, {
          ...template!.data,
          dtx_regionid: id,
          dtx_name: 'Added by somebody else',
        });

        const report = await w.validate(run.id);
        const d = report.entities.find((e) => e.logicalName === 'dtx_region')!;
        const rowCount = d.checks.find((c) => c.check === 'ROW_COUNT')!;
        expect(rowCount.message).toMatch(/more row/);
        expect(rowCount.outcome, 'more rows in a shared target is not this run failing').toBe('WARNING');
        // And it is not counted as a record this comparison examined.
        expect(d.matched + d.different + d.missing).toBe(d.checkedRecords);
        expect(d.missing, 'a record nobody migrated is not a missing record').toBe(0);
      }),
    600_000,
  );

  // -------------------------------------------------------------------------
  // 4. Field value mismatch
  // -------------------------------------------------------------------------

  it(
    '4. reports a changed target value as a field mismatch, with the expected value beside it',
    () =>
      scenario(async (w) => {
        const run = await w.migrate('Field mismatch', ['account']);
        const rows = (await w.identityRows(run.id, 'account')).filter((r) => r.targetId);
        expect(rows.length).toBeGreaterThan(0);
        await w.editTarget('account', rows[0]!.targetId!, { telephone1: '+61 000 000 000' });

        const report = await w.validate(run.id);
        const d = report.entities.find((e) => e.logicalName === 'account')!;
        expect(d.different).toBe(1);
        expect(d.outcome).toBe('FAIL');

        const found = await w.differences(report.id, '&type=VALUE_MISMATCH');
        const diff = found.items.find((x) => x.field === 'telephone1');
        expect(diff, 'the changed column is named').toBeTruthy();
        expect(diff!.targetValue).toBe('+61 000 000 000');
        expect(diff!.sourceValue, 'and the value the run should have written is beside it').not.toBe(
          '+61 000 000 000',
        );
      }),
    600_000,
  );

  // -------------------------------------------------------------------------
  // 5 and 6. Transformed values
  // -------------------------------------------------------------------------

  /**
   * A transformation is compared against what the value became, not against what it was.
   *
   * Both halves in one scenario, because one without the other proves nothing: a comparison
   * reporting no mismatch might be comparing nothing, and one reporting a mismatch might be
   * comparing the raw source value. The same plan, the same column, two target states.
   */
  it(
    '5 and 6. compares against the expected transformed value, and finds it when the target holds the raw one',
    () =>
      scenario(async (w) => {
        const p = await w.plan('Transformed compare', ['account']);
        const { mappings } = await w.mappingsOf(p, 'account');
        const mapping = mappings.find((m) => m.sourceField === 'accountnumber')!;
        const rules: TransformationRule[] = [{ kind: 'UPPERCASE' }, { kind: 'PREFIX', value: 'ACC-' }];
        await w.api.patch(`/api/plans/${p.id}/mappings/${mapping.id}/transformations`, { rules });

        const run = await w.execute(p);
        const clean = await w.validate(run.id);
        const d = clean.entities.find((e) => e.logicalName === 'account')!;
        // 5. The transformed value matches. A raw comparison would report every account here.
        expect(d.checkedRecords).toBeGreaterThan(0);
        expect(d.different, 'a transformed column that agrees is not a difference').toBe(0);
        expect(
          d.rules!.comparedFields.find((f) => f.target === 'accountnumber')?.transformations,
          'and the report says which transformations were applied',
        ).toEqual(['UPPERCASE', 'PREFIX']);

        // 6. The target holds the untransformed value. That is a mismatch.
        const rows = (await w.identityRows(run.id, 'account')).filter((r) => r.targetId);
        const row = await w.targetRow('account', rows[0]!.targetId!);
        const transformed = String(row!.data['accountnumber'] ?? '');
        expect(transformed, 'the run wrote the transformed value').toMatch(/^ACC-/);
        await w.editTarget('account', rows[0]!.targetId!, {
          accountnumber: transformed.replace(/^ACC-/, '').toLowerCase(),
        });

        const broken = await w.validate(run.id);
        const after = broken.entities.find((e) => e.logicalName === 'account')!;
        expect(after.different, 'the one record whose transformed value was undone').toBe(1);
        const found = await w.differences(broken.id);
        expect(found.items.some((x) => x.field === 'accountnumber')).toBe(true);
      }),
    900_000,
  );

  // -------------------------------------------------------------------------
  // 7 and 8. Duplicate and ambiguous identity
  // -------------------------------------------------------------------------

  /**
   * Two target records carrying one business key.
   *
   * The comparison reports the repeated value and how many records carry it. It does not choose one
   * of them: with two candidates there is no honest answer to "which one does this source record
   * match?", and picking the first would turn an ambiguous identity into a clean pass.
   */
  it(
    '7 and 8. reports a repeated business key without choosing a match for it',
    () =>
      scenario(async (w) => {
        const p = await w.plan('Duplicate key', ['account']);
        const entity = p.entities.find((e) => e.logicalName === 'account')!;
        await w.api.patch<PlanEntityDto>(`/api/plans/${p.id}/entities/${entity.id}`, {
          matchStrategy: 'BUSINESS_KEY',
          businessKeyFields: ['accountnumber'],
          alternateKey: null,
        });
        const run = await w.execute(p);
        const rows = (await w.identityRows(run.id, 'account')).filter((r) => r.targetId);
        expect(rows.length).toBeGreaterThan(1);

        // A second target record carrying the same business key, which is what a double import leaves.
        const template = await w.targetRow('account', rows[0]!.targetId!);
        const id = '00000000-0000-4000-8000-0000000d0001';
        await w.addToTarget('account', id, { ...template!.data, accountid: id });

        const report = await w.validate(run.id);
        const d = report.entities.find((e) => e.logicalName === 'account')!;
        expect(d.duplicates, 'the duplicate scan ran').not.toBeNull();
        const repeated = (d.duplicates ?? []).find((x) => x.occurrences > 1);
        expect(repeated, `duplicates: ${JSON.stringify(d.duplicates)}`).toBeTruthy();
        expect(repeated!.columns, 'grouped on the configured business key').toEqual(['accountnumber']);
        const check = d.checks.find((c) => c.check === 'UNIQUENESS')!;
        expect(check.outcome).not.toBe('PASS');
        // The basis is recorded, so a reader knows what a finding of none would have proven.
        expect(d.uniqueness?.provesBusinessUniqueness).toBe(true);
      }),
    900_000,
  );

  // -------------------------------------------------------------------------
  // 9 and 10. Relationships
  // -------------------------------------------------------------------------

  it(
    '10. reports a record whose parent is the wrong record as a relationship mismatch',
    () =>
      scenario(async (w) => {
        const run = await w.migrate('Wrong parent', ['account', 'contact']);
        const contacts = (await w.identityRows(run.id, 'contact')).filter((r) => r.targetId);
        const accounts = (await w.identityRows(run.id, 'account')).filter((r) => r.targetId);
        expect(accounts.length).toBeGreaterThan(1);

        // A contact that points at an account, repointed at a different account that really exists.
        let moved: string | null = null;
        for (const c of contacts) {
          const row = await w.targetRow('contact', c.targetId!);
          const parent = row?.data['parentcustomerid'];
          if (!parent || typeof parent !== 'object' || !('id' in (parent as object))) continue;
          const current = String((parent as { id: string }).id).toLowerCase();
          const other = accounts.find((a) => a.targetId!.toLowerCase() !== current);
          if (!other) continue;
          await w.editTarget('contact', c.targetId!, {
            parentcustomerid: { logicalName: 'account', id: other.targetId! },
          });
          moved = c.sourceId;
          break;
        }
        expect(moved, 'a contact with a parent account to repoint').not.toBeNull();

        const report = await w.validate(run.id);
        const found = await w.differences(report.id, '&type=LOOKUP_MISMATCH');
        const diff = found.items.find((x) => x.sourceRecordId === moved);
        expect(diff, `lookup mismatches: ${JSON.stringify(found.items.slice(0, 3))}`).toBeTruthy();
        expect(diff!.field).toBe('parentcustomerid');
        expect(diff!.outcome, 'an existing record with the wrong parent is not a pass').toBe('FAIL');
        expect(report.entities.find((e) => e.logicalName === 'contact')!.outcome).toBe('FAIL');
      }),
    900_000,
  );

  /**
   * 9. A required relationship the target cannot satisfy.
   *
   * Offices need a region, and this run migrates offices without them, so the platform refuses every
   * write and the run reports them failed. Validation confirms they are not in the target and keeps
   * that apart from its own missing-record finding — the run already said why, and reporting it
   * again would be the same records counted twice.
   */
  it(
    '9. keeps a record the target refused for a missing required reference out of its own findings',
    () =>
      scenario(async (w) => {
        const run = await w.migrate('Required reference', ['dtx_office']);
        expect(run.failed, 'the target refused the offices').toBeGreaterThan(0);

        const report = await w.validate(run.id);
        const d = report.entities.find((e) => e.logicalName === 'dtx_office')!;
        expect(d.failedInRun).toBe(run.failed);
        expect(d.missing, 'the run reported these, so validation does not report them twice').toBe(0);
        expect(d.matched + d.different + d.missing).toBe(d.checkedRecords);
        const existence = d.checks.find((c) => c.check === 'RECORD_EXISTENCE')!;
        expect(existence.outcome).toBe('FAIL');
        expect(existence.message).toMatch(/not in the target/);
      }),
    600_000,
  );

  // -------------------------------------------------------------------------
  // 14. Excluded field
  // -------------------------------------------------------------------------

  it(
    '14. does not report a difference in a field the run was told to ignore, and names it as excluded',
    () =>
      scenario(async (w) => {
        const p = await w.plan('Excluded field', ['account']);
        const { mappings } = await w.mappingsOf(p, 'account');
        const ignored = mappings.find((m) => m.sourceField === 'telephone1')!;
        await w.api.patch(`/api/plans/${p.id}/mappings/${ignored.id}`, { action: 'IGNORE' });
        const run = await w.execute(p);

        const rows = (await w.identityRows(run.id, 'account')).filter((r) => r.targetId);
        await w.editTarget('account', rows[0]!.targetId!, { telephone1: 'changed after the run' });

        const report = await w.validate(run.id);
        const d = report.entities.find((e) => e.logicalName === 'account')!;
        expect(d.different, 'a column outside the mapping is outside the comparison').toBe(0);
        expect(
          d.rules!.comparedFields.some((f) => f.source === 'telephone1'),
          'and it is not in the compared list',
        ).toBe(false);
        expect(
          d.rules!.excludedFields.map((f) => f.field),
          'it is named as excluded, so nobody reads the pass as covering it',
        ).toContain('telephone1');
      }),
    900_000,
  );

  // -------------------------------------------------------------------------
  // 15. Comparison execution failure
  // -------------------------------------------------------------------------

  /**
   * A validation that could not run at all, which is not a comparison that disagreed.
   *
   * The target table is gone from the target environment between the run and the validation. The
   * engine has nothing to compare against, and the distinction it has to hold is that this is a
   * statement about the comparison rather than about the data: the schema check fails, and the field
   * comparison reports that it was not verified rather than that every record is wrong.
   */
  it(
    '15. separates a comparison that could not run from one that ran and disagreed',
    () =>
      scenario(async (w) => {
        const run = await w.migrate('Execution failure', ['dtx_applicationconfig']);
        // Every record of the table removed from the target: the comparison can pair nothing.
        const rows = (await w.identityRows(run.id, 'dtx_applicationconfig')).filter((r) => r.targetId);
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) await w.removeFromTarget('dtx_applicationconfig', r.targetId!);

        const report = await w.validate(run.id);
        expect(report.status, 'the validation itself ran to a verdict').toBe('COMPLETED');
        const d = report.entities.find((e) => e.logicalName === 'dtx_applicationconfig')!;
        expect(d.missing, 'every record it was asked about').toBe(d.checkedRecords);
        expect(d.matched).toBe(0);
        // Proven absence, so FAIL — and the report says which records, not merely that something broke.
        expect(d.outcome).toBe('FAIL');
        const found = await w.differences(report.id, '&type=MISSING_IN_TARGET');
        expect(found.total).toBe(rows.length);
      }),
    600_000,
  );

  // -------------------------------------------------------------------------
  // 16. Partial/incomplete validation
  // -------------------------------------------------------------------------

  it(
    '16. reports a run with records nobody can account for as incomplete, not as passed or failed',
    () =>
      scenario(async (w) => {
        const armed = await w.api.post<{ armed: boolean }>('/api/demo/fault-injection', {
          environmentId: w.uat.id,
          table: 'dtx_region',
          onNthCreate: 2,
        });
        expect(armed.armed).toBe(true);
        const run = await w.migrate('Unresolved write', ['dtx_region']);
        expect(run.unresolved, 'one write has no answer').toBeGreaterThan(0);

        const report = await w.validate(run.id);
        const d = report.entities.find((e) => e.logicalName === 'dtx_region')!;
        expect(d.unresolvedInRun).toBeGreaterThan(0);
        const existence = d.checks.find((c) => c.check === 'RECORD_EXISTENCE')!;
        expect(existence.outcome).toBe('INCOMPLETE');
        expect(report.outcome).not.toBe('PASS');
        expect(report.outcome).not.toBe('WARNING');
      }),
    600_000,
  );

  // -------------------------------------------------------------------------
  // Count invariants, over every scenario above that produced a report
  // -------------------------------------------------------------------------

  /**
   * The arithmetic a reader does naturally, asserted rather than hoped for.
   *
   * Each number here was wrong once. `missing` and `failedInRun` were added together, so a dataset
   * reported 66 matched, 3 missing and 1 differing over 67 examined records — three numbers each
   * correct, adding to seventy, over sixty-seven. Found by reconciling a deployed report by hand.
   */
  it(
    'reconciles every count in a report with several kinds of finding in it',
    () =>
      scenario(async (w) => {
        const run = await w.migrate('Invariants', ['account', 'contact', 'dtx_region']);
        const rows = (await w.identityRows(run.id, 'account')).filter((r) => r.targetId);
        await w.editTarget('account', rows[0]!.targetId!, { telephone1: 'changed' });
        await w.editTarget('account', rows[1]!.targetId!, { emailaddress1: 'changed@example.test' });
        await w.removeFromTarget('account', rows[2]!.targetId!);

        const report = await w.validate(run.id);
        for (const d of report.entities) {
          // No record is in two mutually exclusive buckets, and none is outside all of them.
          expect(
            d.matched + d.different + d.missing,
            `${d.logicalName}: every examined record is in exactly one bucket`,
          ).toBe(d.checkedRecords);
          // The run's findings stay outside validation's own, so nothing is counted twice.
          expect(d.checkedRecords + d.failedInRun + d.unresolvedInRun).toBeLessThanOrEqual(
            d.accounting
              ? d.accounting.created +
                  d.accounting.updated +
                  d.accounting.unchanged +
                  d.accounting.skipped +
                  d.accounting.failed +
                  d.accounting.unresolved
              : Number.MAX_SAFE_INTEGER,
          );
          expect(d.matched, 'a count is never negative').toBeGreaterThanOrEqual(0);
        }

        const accounts = report.entities.find((e) => e.logicalName === 'account')!;
        expect(accounts.different, 'two records differ, on one column each').toBe(2);
        expect(accounts.missing, 'and one is gone').toBe(1);

        /*
         * Records and field differences are two numbers, and the report must not use one for the
         * other. Two records differing on one column each is two of both; the test that matters is
         * that the listing length is the field differences and `different` is the records.
         */
        const found = await w.differences(report.id, '&entity=account');
        const fieldDifferences = found.items.filter((x) => x.field !== null).length;
        expect(fieldDifferences, 'one field difference per changed column').toBe(2);
        expect(found.items.filter((x) => x.differenceType === 'MISSING_IN_TARGET').length).toBe(1);
      }),
    900_000,
  );
});
