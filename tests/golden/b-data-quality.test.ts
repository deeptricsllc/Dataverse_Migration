import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MigrationErrorDto, ValidationDifferenceDto } from '../../shared/domain';
import {
  createPlan,
  evidence,
  execute,
  openJourney,
  readiness,
  seedRows,
  targetRows,
  validate,
  type Journey,
} from './journey';

/**
 * Golden Journey B — data the target will not accept.
 *
 * A value too long for the column it is going into, migrated from an environment where it fits to one
 * where it does not. The whole chain has to hold: the problem is named **before** the migration, the
 * migration refuses the record rather than quietly shortening it, validation reports the record as
 * absent rather than matched, and the evidence names which record it was.
 *
 * The failure mode this guards against is the quiet one. Nothing here would look wrong if the product
 * truncated the value and reported success: the record would be in the target, the counts would add up,
 * and a column would be holding 100 characters of a 150-character address with nobody told. Silent
 * truncation is the worst outcome available and it is the easiest one to implement by accident.
 */
describe('Golden Journey B: data the target will not accept', () => {
  let j: Journey;
  /** `websiteurl` holds 200 characters in Development and 100 in QA. */
  const TOO_LONG = `https://example.com/${'x'.repeat(130)}`;
  const MARKER = 'LONGURL-01';

  beforeAll(async () => {
    j = await openJourney();
    await seedRows(j, j.dev, 'account', [
      {
        accountid: '00000000-0000-4000-9000-00000000cccc',
        name: 'Account With A Long Website',
        accountnumber: MARKER,
        websiteurl: TOO_LONG,
      },
    ]);
  }, 300_000);
  afterAll(async () => {
    await j?.close();
  });

  it('names the problem before migrating, refuses the record, and says so afterwards', async () => {
    const plan = await createPlan(j, {
      name: 'Golden B',
      source: j.dev,
      target: j.qa,
      tables: ['account'],
    });

    // --- 1. before: the problem is identified ------------------------------
    const assessment = await readiness(j, plan.id);
    const narrow = assessment.findings.find(
      (f) => f.code === 'SCHEMA_MAXLENGTH' && f.object?.name === 'account.websiteurl',
    );
    expect(narrow, 'readiness names the narrower column before anything is written').toBeTruthy();
    expect(narrow!.evidence).toMatch(/longer than 100 characters/);
    expect(narrow!.recommendation, 'and says what to do about it').toBeTruthy();
    expect(narrow!.severity).toBe('WARNING');

    /**
     * Every finding is read by somebody. A template that interpolated an object would print
     * "[object Object]" to a customer, which is how `CONNECTOR_NOT_ENGINE_VERIFIED` was printing its
     * verification level when this journey was written.
     */
    for (const finding of assessment.findings) {
      for (const text of [finding.evidence, finding.explanation, finding.recommendation]) {
        expect(text, `${finding.code} prints an object`).not.toContain('[object Object]');
        expect(text, `${finding.code} prints undefined`).not.toContain('undefined');
        expect(String(text).length, `${finding.code} has nothing to say`).toBeGreaterThan(10);
      }
    }

    // --- 2. during: refused, not shortened ---------------------------------
    const run = await execute(j, plan);
    expect(run.status, 'a record the target will not take is an error').toBe('COMPLETED_WITH_ERRORS');
    expect(run.failed).toBeGreaterThan(0);

    /**
     * The independent check, and the point of the journey: the record is not in the target at all.
     * A truncated copy of it would be worse than its absence, because its absence is reported.
     */
    const inTarget = (await targetRows(j, j.qa, 'account')).filter((r) => r.data.accountnumber === MARKER);
    expect(inTarget, 'nothing was written for the rejected record').toEqual([]);

    // And nowhere in the target is there a shortened version of that value.
    const shortened = (await targetRows(j, j.qa, 'account')).filter((r) =>
      String(r.data.websiteurl ?? '').startsWith('https://example.com/xxxx'),
    );
    expect(shortened, 'no truncated copy was written under any other record').toEqual([]);

    const errors = await j.api.get(`/api/runs/${run.id}/errors`);
    const items: MigrationErrorDto[] = Array.isArray(errors) ? errors : errors.items;
    expect(items.length, 'the run says which records it refused and why').toBeGreaterThan(0);
    for (const item of items) {
      expect(item.message).not.toContain('[object Object]');
      expect(item.sourceRecordId, 'each error names a record').toBeTruthy();
      expect(item.errorCode, 'and classifies it, so like problems can be counted together').toBeTruthy();
    }
    // The column that caused it is named, which is what makes the error actionable.
    expect(
      items.some((e) => e.field === 'websiteurl'),
      'the refusal names the column that would not take the value',
    ).toBe(true);

    // --- 3. after: validation reports it as absent, not as matched ---------
    const report = await validate(j, run.id, 'FULL');
    expect(report.outcome, 'a run that could not deliver records does not pass').toBe('FAIL');

    const entity = report.entities.find((e) => e.logicalName === 'account')!;
    expect(entity.failedInRun, 'counted as the run’s failure, which it already knew about').toBe(run.failed);
    expect(entity.missing, 'and not double-counted as validation’s own finding').toBe(0);

    const existence = entity.checks.find((c) => c.check === 'RECORD_EXISTENCE')!;
    expect(existence.outcome).toBe('FAIL');
    expect(existence.message, 'and says the run is the reason').toMatch(/failed/i);

    // The schema difference is reported as a difference in the schema, not as a data problem.
    const schema = entity.checks.find((c) => c.check === 'SCHEMA')!;
    expect(schema.outcome).not.toBe('PASS');
    expect(schema.message).toMatch(/websiteurl/);

    // --- 4. remediation: which record, by name -----------------------------
    const differences = await j.api.get(`/api/validations/${report.id}/differences`);
    const diffs: ValidationDifferenceDto[] = Array.isArray(differences) ? differences : differences.items;
    /*
     * `RECORD_FAILED_IN_RUN`, not `MISSING_IN_TARGET`. The two were one category, and they are two
     * findings with two next actions: the run reported these as failed and said why, so the reader
     * goes to the run's failure list rather than opening an investigation into where a record went.
     */
    const missing = diffs.filter((d) => d.differenceType === 'RECORD_FAILED_IN_RUN');
    expect(missing.length, 'the records to go and fix are listed individually').toBeGreaterThan(0);
    expect(
      missing.some((d) => d.sourceRecordId === '00000000-0000-4000-9000-00000000cccc'),
      'including the one this journey created',
    ).toBe(true);
    for (const d of missing) {
      expect(d.targetRecordId, 'nothing is invented for a record that is not there').toBeNull();
    }

    // --- 5. and the evidence package carries the same story ----------------
    const pack = await evidence(j, run.id);
    expect(pack.verdict, pack.problems.join('; ')).toBe('VALID');
  }, 1_200_000);
});
