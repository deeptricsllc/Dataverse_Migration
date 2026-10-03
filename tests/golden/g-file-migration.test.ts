import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MigrationPlanDto } from '../../shared/domain';
import { writtenByRun } from '../../shared/run-metrics';
import {
  evidence,
  execute,
  keyCensus,
  lineage,
  openJourney,
  targetRows,
  validate,
  type Journey,
} from './journey';

/**
 * Golden Journey G — a spreadsheet into a table.
 *
 * This journey exists because of five separate bugs found by migrating one CSV by hand, every one of
 * them in code that had passing tests. The chain was what nobody ran:
 *
 *   1. no column could be mapped, because writability flags describing *the uploaded file* were used
 *      to judge whether the data could be written;
 *   2. the key column could not be mapped, because it was treated as a platform primary id;
 *   3. the key column's value was dropped on read, so the records had no key;
 *   4. validation could not re-read a source whose ids are not GUIDs;
 *   5. and a validation that compared nothing reported
 *      `PASS: Not verified — No records were examined. Every one of them is in the target.`
 *
 * The fifth is the one worth remembering: a confident pass over an empty comparison. So this journey
 * checks the values that arrived, not only that something arrived, and it refuses a pass that examined
 * no records.
 */
describe('Golden Journey G: a spreadsheet into a table', () => {
  let j: Journey;
  const ROWS = 40;
  /** Deliberately not GUIDs: the uploaded key is a product code, which broke validation's re-read. */
  const code = (i: number) => `FILE-${String(i).padStart(4, '0')}`;

  beforeAll(async () => {
    j = await openJourney();
  }, 180_000);
  afterAll(async () => {
    await j?.close();
  });

  it('uploads, maps every column, migrates the values, and validates against the file', async () => {
    // --- the file ----------------------------------------------------------
    const header = 'code,full_name,list_price,notes';
    const lines = [header];
    for (let i = 0; i < ROWS; i++) {
      // A comma inside a quoted field, because a CSV reader that cannot do this loses columns.
      lines.push(`${code(i)},"Widget ${i}, standard",${(i % 89) + 0.25},Imported from a spreadsheet`);
    }
    const csv = lines.join('\r\n');

    const staged = await j.api.post<{ id: string; displayName: string }>(
      '/api/staged-sources',
      { displayName: `Golden G ${Date.now()}`, kind: 'UPLOAD' },
      201,
    );
    const imported = await j.api.post<{ tables?: { rowCount: number }[] }>(
      `/api/staged-sources/${staged.id}/import`,
      { filename: 'products.csv', contentBase64: Buffer.from(csv, 'utf8').toString('base64') },
    );
    expect(imported.tables?.[0]?.rowCount, 'every row was read, including the quoted commas').toBe(ROWS);

    const tables = await j.api.get<{ logicalName: string }[]>(`/api/staged-sources/${staged.id}/tables`);
    expect(tables.length).toBe(1);

    // --- the plan ----------------------------------------------------------
    const created = await j.api.post<MigrationPlanDto>('/api/plans', {
      name: `Golden G ${Date.now()}`,
      sourceEnvironmentId: staged.id,
      targetEnvironmentId: j.uat.id,
      tables: [tables[0]!.logicalName],
    });
    const plan = await j.api.get<MigrationPlanDto>(`/api/plans/${created.id}`);
    const entity = plan.entities[0]!;
    await j.api.patch(`/api/plans/${plan.id}/entities/${entity.id}/object-mapping`, {
      targetLogicalName: 'product',
      status: 'MANUAL',
    });

    // --- the mapping, which is where the first three bugs lived ------------
    const mappings = await j.api.get<{
      mappings: { id: string; sourceField: string; isMappable?: boolean }[];
    }>(`/api/plans/${plan.id}/entities/${entity.id}/mappings`);
    const bySource = new Map(mappings.mappings.map((m) => [m.sourceField, m]));

    for (const column of ['code', 'full_name', 'list_price', 'notes']) {
      expect(bySource.get(column), `the uploaded column ${column} is offered for mapping`).toBeTruthy();
    }
    /**
     * The key column in particular. It was unmappable twice over: once because the file's own
     * writability was used to judge the data, and once because a key column was treated as a platform
     * primary id that a migration must not supply.
     */
    const keyColumn = bySource.get('code')!;
    expect(keyColumn.isMappable ?? true, 'the key column can be mapped like any other').not.toBe(false);

    const map = async (sourceField: string, targetField: string) => {
      const m = bySource.get(sourceField)!;
      await j.api.patch(`/api/plans/${plan.id}/mappings/${m.id}`, { action: 'MAP', targetField });
    };
    await map('code', 'productnumber');
    await map('full_name', 'name');
    await map('list_price', 'price');
    await j.api.patch(`/api/plans/${plan.id}/mappings/${bySource.get('notes')!.id}`, {
      action: 'IGNORE',
    });

    // Matched on the business key the file carries, which is the configuration a readiness assessment
    // recommends and the only one that makes a resume of an uploaded file safe.
    await j.api.patch(`/api/plans/${plan.id}/entities/${entity.id}`, {
      matchStrategy: 'BUSINESS_KEY',
      alternateKey: null,
      businessKeyFields: ['productnumber'],
    });

    // --- the migration -----------------------------------------------------
    const run = await execute(j, await j.api.get<MigrationPlanDto>(`/api/plans/${plan.id}`));
    expect(run.status, run.errorMessage ?? '').toBe('COMPLETED');
    expect(run.total).toBe(ROWS);
    expect(run.created).toBe(ROWS);
    expect(run.failed).toBe(0);
    expect(run.unresolved).toBe(0);

    // --- the independent look: the values, not just the count --------------
    const rows = await targetRows(j, j.uat, 'product');
    const mine = rows.filter((r) => String(r.data.productnumber ?? '').startsWith('FILE-'));
    expect(mine.length, 'one target record per row in the file').toBe(ROWS);

    /**
     * The third bug was that the key column's value was dropped on read, so records arrived with no
     * key at all. Counting rows would not have caught it; reading them does.
     */
    const census = keyCensus(mine, 'productnumber');
    expect(census.distinct, 'every record carries its own key from the file').toBe(ROWS);
    expect(census.repeated).toEqual([]);
    expect(
      mine.filter((r) => !r.data.productnumber),
      'no record arrived without its key',
    ).toEqual([]);

    const sample = mine.find((r) => r.data.productnumber === code(7))!;
    expect(sample, 'a row from the middle of the file is there').toBeTruthy();
    expect(sample.data.name, 'and the quoted comma survived the whole chain').toBe('Widget 7, standard');
    expect(Number(sample.data.price)).toBeCloseTo(7 + 0.25, 2);

    // --- lineage: a non-GUID source key, carried as itself -----------------
    const lineageRows = await lineage(j, run.id);
    expect(lineageRows.length).toBe(ROWS);
    expect(
      lineageRows.every((r) => r['Source id'].length > 0),
      'every row names its source record',
    ).toBe(true);
    expect(new Set(lineageRows.map((r) => r['Source id'])).size).toBe(ROWS);
    expect(new Set(lineageRows.map((r) => r['Write state']))).toEqual(new Set(['CONFIRMED']));

    // --- validation: it must actually compare something --------------------
    const report = await validate(j, run.id, 'FULL');
    const result =
      report.entities.find((e) => e.logicalName === tables[0]!.logicalName) ?? report.entities[0]!;

    /**
     * The fifth bug, guarded directly. A validation that examined nothing reported a confident pass.
     * Coverage is the thing that makes the verdict mean anything, so it is asserted before the verdict.
     */
    expect(result.checkedRecords, 'records were actually examined').toBe(ROWS);
    expect(result.coverage!.mode).toBe('FULL');
    expect(result.coverage!.examined).toBe(ROWS);
    expect(result.coverage!.eligible).toBe(ROWS);
    expect(result.matched, 'and compared, field by field').toBe(ROWS);
    expect(result.missing).toBe(0);
    expect(result.different).toBe(0);
    for (const check of result.checks) {
      expect(check.message, 'no check claims a pass over nothing').not.toMatch(/No records were examined/i);
    }
    /**
     * Nothing failed. The one warning is the schema: a four-column spreadsheet going into a table with
     * twenty columns differs from it by sixteen, which is a fact about the file rather than a problem
     * with the migration — and demanding PASS here would mean demanding that the product stop
     * mentioning it.
     */
    const notPassing = result.checks.filter((c) => c.outcome !== 'PASS');
    expect(
      notPassing.filter((c) => c.outcome === 'FAIL'),
      JSON.stringify(notPassing),
    ).toEqual([]);
    expect(
      notPassing.map((c) => c.check),
      'the only reservation is about the shape of the file',
    ).toEqual(['SCHEMA']);
    expect(report.outcome).toBe('WARNING');
    expect(report.summary!.matchedRecords).toBe(writtenByRun(run));

    // Uniqueness was tested on the file's own key, not on a primary key the target enforces.
    expect(result.uniqueness!.basis).toBe('BUSINESS_KEY');
    expect(result.uniqueness!.provesBusinessUniqueness).toBe(true);
    expect(result.duplicates).toEqual([]);

    // --- evidence ----------------------------------------------------------
    const pack = await evidence(j, run.id);
    expect(pack.verdict, pack.problems.join('; ')).toBe('VALID');
  }, 1_200_000);
});
