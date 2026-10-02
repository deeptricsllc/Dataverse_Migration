import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VALIDATION_DEPTHS } from '../../shared/validation-coverage';
import { writtenByRun } from '../../shared/run-metrics';
import {
  createPlan,
  evidence,
  execute,
  openJourney,
  seedRows,
  targetRows,
  validate,
  type Journey,
} from './journey';

/**
 * Golden Journey E — a dataset bigger than the validation will read.
 *
 * Above the depth's cap, validation examines a subset. The failure this journey exists to prevent is
 * not sampling — sampling is correct and necessary — it is a **sampled result presented as a complete
 * one**. A report that examined 500 of 700 records and says "every record matched" is a lie about the
 * other 200, and it is the kind of lie that only shows up when somebody is asked to sign for it.
 *
 * So the journey asserts the four things a reader needs in order to know what they are reading:
 * that it was sampled, how many were eligible, how many were examined, and how those were chosen.
 * Then it runs the same data at FULL depth and asserts the claim gets stronger — because a product
 * where both depths say the same thing has one of them wrong.
 */
describe('Golden Journey E: a dataset above the sampling threshold', () => {
  let j: Journey;
  const TABLE = 'dtx_office';
  const QUICK_CAP = VALIDATION_DEPTHS.QUICK.perTable;
  /** Comfortably above the cap, and small enough to migrate in a test. */
  const EXTRA_ROWS = QUICK_CAP + 200;

  beforeAll(async () => {
    j = await openJourney();
    const existingRows = await targetRows(j, j.dev, TABLE);
    /**
     * `dtx_regionid` is required on an office, so the seeded rows borrow the region an existing office
     * already points at. Inventing a lookup value would make this a journey about broken references.
     */
    const region = existingRows[0]?.data.dtx_regionid;
    expect(region, 'the demo source has an office with a region to borrow').toBeTruthy();
    await seedRows(
      j,
      j.dev,
      TABLE,
      Array.from({ length: EXTRA_ROWS }, (_, i) => {
        const id = `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`;
        return {
          dtx_officeid: id,
          dtx_name: `Sampled Office ${i}`,
          dtx_city: `City ${i % 40}`,
          dtx_headcount: (i % 50) + 1,
          dtx_regionid: region,
        };
      }),
    );
    expect((await targetRows(j, j.dev, TABLE)).length).toBe(existingRows.length + EXTRA_ROWS);
  }, 300_000);
  afterAll(async () => {
    await j?.close();
  });

  it('says SAMPLED, says how much it read, and never claims more than it examined', async () => {
    const plan = await createPlan(j, {
      name: 'Golden E',
      source: j.dev,
      target: j.uat,
      // The region has to be in the target before the offices that point at it.
      tables: ['dtx_region', TABLE],
      batchSize: 200,
    });
    const run = await execute(j, plan);
    expect(run.status).toBe('COMPLETED');
    expect(run.failed).toBe(0);
    expect(run.unresolved).toBe(0);

    const officeEntity = run.entities.find((e) => e.logicalName === TABLE)!;
    const written = writtenByRun(officeEntity);
    expect(written, 'more records than a quick validation will read').toBeGreaterThan(QUICK_CAP);
    // The independent check: the target holds what the run says it wrote.
    expect((await targetRows(j, j.uat, TABLE)).length).toBe(written);

    // --- quick: sampled, and saying so -------------------------------------
    const quick = await validate(j, run.id, 'QUICK');
    expect(quick.status).toBe('COMPLETED');
    const entity = quick.entities.find((e) => e.logicalName === TABLE)!;
    const coverage = entity.coverage!;

    expect(coverage.mode, 'a dataset above the cap is reported as sampled').toBe('SAMPLED');
    expect(coverage.eligible, 'how many records could have been examined').toBe(written);
    expect(coverage.examined, 'how many actually were').toBe(QUICK_CAP);
    expect(coverage.examined).toBeLessThan(coverage.eligible);
    expect(entity.checkedRecords).toBe(QUICK_CAP);
    // How they were chosen, which is what makes the number mean anything.
    expect(coverage.deterministic, 'the same depth examines the same records again').toBe(true);
    expect(coverage.strategy ?? '', 'the strategy is named, not implied').toBeTruthy();

    /**
     * The claim itself. Every sentence in a sampled report has to be about the records that were read,
     * so none of them may use the words that mean "all of them".
     */
    for (const check of entity.checks) {
      expect(check.message, `a sampled report never says everything: ${check.message}`).not.toMatch(
        /\ball (records|of them)\b|\bevery record\b/i,
      );
    }
    expect(quick.summary!.coverage!.mode, 'and the summary carries the weakest claim').toBe('SAMPLED');

    // What it did examine, it found correct — so SAMPLED here is about scope, not about failure.
    expect(entity.missing).toBe(0);
    expect(entity.different).toBe(0);
    expect(entity.matched).toBe(QUICK_CAP);

    // --- full: the same data, a stronger claim ------------------------------
    const full = await validate(j, run.id, 'FULL');
    const fullEntity = full.entities.find((e) => e.logicalName === TABLE)!;
    expect(fullEntity.coverage!.mode, 'only FULL can report full coverage').toBe('FULL');
    expect(fullEntity.coverage!.examined).toBe(written);
    expect(fullEntity.coverage!.examined).toBe(fullEntity.coverage!.eligible);
    expect(fullEntity.matched).toBe(written);
    expect(fullEntity.missing).toBe(0);
    expect(fullEntity.different).toBe(0);

    // The two depths disagree about scope and agree about the data, which is the point.
    expect(fullEntity.coverage!.examined).toBeGreaterThan(coverage.examined);
    expect(full.outcome).toBe('PASS');

    // --- and the evidence records which one was produced -------------------
    const pack = await evidence(j, run.id);
    expect(pack.verdict, pack.problems.join('; ')).toBe('VALID');
  }, 1_200_000);
});
