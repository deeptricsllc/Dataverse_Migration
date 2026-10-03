import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ValidationRunDto } from '../../shared/domain';
import {
  createPlan,
  execute,
  keyCensus,
  lineage,
  openJourney,
  seedRows,
  targetRows,
  validate,
  type Journey,
} from './journey';

/**
 * Golden Journey F — duplicates, on a key that means something.
 *
 * The distinction this journey exists to hold: a duplicate check against a primary key the target
 * already enforces proves nothing about the data. It can only ever find nothing, because the target
 * refuses a repeated primary key by itself. So this journey uses keys nothing protects for us, and asks
 * the two questions that actually matter:
 *
 *   1. **Prevention** — two source records sharing a business key must not become two target records.
 *   2. **Detection** — a target record sharing a key with one of ours must be found, named, counted and
 *      attributed.
 *
 * Each half uses a different basis, because the report distinguishes them: `accountnumber`, a business
 * key the plan chose and nothing enforces, and `productnumber`, an alternate key the target declares.
 */
describe('Golden Journey F: duplicates on a key that means something', () => {
  let j: Journey;

  beforeAll(async () => {
    j = await openJourney();
  }, 180_000);
  afterAll(async () => {
    await j?.close();
  });

  // --- prevention -----------------------------------------------------------
  it('refuses to create a second record for the same business key, and names the one it refused', async () => {
    const KEY = 'accountnumber';
    const SHARED = 'TWIN-0001';
    const sourceBefore = (await targetRows(j, j.dev, 'account')).length;

    // Two source records, different identifiers, the same business key. Nothing in the target stops
    // both being written; only the match strategy does.
    await seedRows(j, j.dev, 'account', [
      { accountid: '00000000-0000-4000-9000-00000000aaa1', name: 'Twin One', [KEY]: SHARED },
      { accountid: '00000000-0000-4000-9000-00000000aaa2', name: 'Twin Two', [KEY]: SHARED },
    ]);
    expect((await targetRows(j, j.dev, 'account')).length).toBe(sourceBefore + 2);

    const plan = await createPlan(j, {
      name: 'Golden F prevention',
      source: j.dev,
      target: j.uat,
      tables: ['account'],
      match: { matchStrategy: 'BUSINESS_KEY', businessKeyFields: [KEY] },
    });
    const run = await execute(j, plan);

    /**
     * The honest outcome. The product does not write the second record, and it does not quietly drop
     * it either — it reports a failure, which is what puts the decision in front of somebody who can
     * resolve it.
     */
    expect(run.status, 'a refused record is an error, not a quiet success').toBe('COMPLETED_WITH_ERRORS');
    expect(run.failed).toBe(1);
    expect(run.created).toBe(sourceBefore + 1);

    // --- the independent look: one record, not two -------------------------
    const rows = await targetRows(j, j.uat, 'account');
    expect(keyCensus(rows, KEY).repeated, 'no business key appears twice in the target').toEqual([]);
    expect(
      rows.filter((r) => r.data[KEY] === SHARED),
      'exactly one record for the shared key',
    ).toHaveLength(1);
    expect(rows.length).toBe(run.created);

    // --- and which record was refused --------------------------------------
    const refused = (await lineage(j, run.id)).filter((r) => r.Outcome === 'FAILED');
    expect(refused, 'one named record, not a count on its own').toHaveLength(1);
    expect(refused[0]!['Target id'], 'nothing was written for it, so it claims no target record').toBe('');

    const errors = await j.api.get(`/api/runs/${run.id}/errors`);
    const items: { message: string }[] = Array.isArray(errors) ? errors : errors.items;
    expect(items.length, 'the reason is available, not only the fact').toBeGreaterThan(0);
    expect(
      items.some((e) => e.message.length > 10),
      'and it is in words',
    ).toBe(true);

    // --- validation does not paper over it ---------------------------------
    const report = await validate(j, run.id, 'FULL');
    expect(report.outcome, 'a record that is not there cannot pass').toBe('FAIL');
    const entity = report.entities.find((e) => e.logicalName === 'account')!;
    expect(entity.failedInRun, 'the run’s own failure, not validation’s finding').toBe(1);

    // The uniqueness claim is about the business key, and says it establishes something.
    expect(entity.uniqueness!.basis).toBe('BUSINESS_KEY');
    expect(entity.uniqueness!.columns).toEqual([KEY]);
    expect(entity.uniqueness!.enforcedByTarget, 'nothing in the target enforces this').toBe(false);
    expect(entity.uniqueness!.provesBusinessUniqueness).toBe(true);
    expect(entity.duplicates, 'and it found none, because none were created').toEqual([]);
    expect(report.summary!.businessUniquenessVerifiedTables).toBe(1);
  }, 900_000);

  // --- detection ------------------------------------------------------------
  it('finds a duplicate that arrived by another route, and attributes it correctly', async () => {
    /**
     * Detection, as distinct from prevention. A record appears in the target by some other means — a
     * second tool, a manual import — sharing a key with one of ours. On `product` that key is an
     * alternate key the target declares, which is a different claim from a business key the plan
     * chose, and the report keeps them apart.
     *
     * `product` is used here rather than `account` because the run doing the detecting has to be the
     * run that wrote one of the two records: attribution asks "did we write one of these", and a later
     * run that skipped everything did not.
     */
    const KEY = 'productnumber';
    const plan = await createPlan(j, {
      name: 'Golden F detection',
      source: j.dev,
      target: j.uat,
      tables: ['product'],
      match: { matchStrategy: 'ALTERNATE_KEY', alternateKey: 'dtx_productnumber_key' },
    });
    const run = await execute(j, plan);
    expect(run.created, 'this run wrote the records it will later be asked about').toBeGreaterThan(0);

    const clean = await validate(j, run.id, 'FULL');
    const cleanEntity = clean.entities.find((e) => e.logicalName === 'product')!;
    expect(cleanEntity.duplicates, 'nothing repeated to begin with').toEqual([]);
    expect(cleanEntity.uniqueness!.basis, 'an alternate key the target declares').toBe('ALTERNATE_KEY');
    expect(cleanEntity.uniqueness!.enforcedByTarget).toBe(true);
    expect(cleanEntity.uniqueness!.provesBusinessUniqueness).toBe(true);

    // A record the migration never wrote, carrying a key that already exists.
    const existing = (await targetRows(j, j.uat, 'product')).find((r) => r.data[KEY])!;
    const intruderKey = String(existing.data[KEY]);
    await seedRows(j, j.uat, 'product', [
      {
        productid: '00000000-0000-4000-9000-00000000bbbb',
        name: 'Arrived by another route',
        [KEY]: intruderKey,
        statecode: 0,
      },
    ]);

    // The target now holds two records sharing that key. Only counting finds this.
    expect(keyCensus(await targetRows(j, j.uat, 'product'), KEY).repeated).toEqual([intruderKey]);

    const again = await j.api.post<ValidationRunDto>('/api/validations', {
      migrationRunId: run.id,
      depth: 'FULL',
    });
    await j.worker.drain(300_000);
    const report = await j.api.get<ValidationRunDto>(`/api/validations/${again.id}`);
    const entity = report.entities.find((e) => e.logicalName === 'product')!;

    expect(entity.duplicates!.length, 'the repeated key was found').toBeGreaterThan(0);
    const found = entity.duplicates!.find((d) => d.value === intruderKey);
    expect(
      found,
      `expected ${intruderKey} among ${entity.duplicates!.map((d) => d.value).join(', ')}`,
    ).toBeTruthy();
    expect(found!.columns, 'grouped on the declared key, not on the primary key').toEqual([KEY]);
    expect(found!.occurrences).toBe(2);
    expect(found!.sampleIds.length, 'records somebody can go and look at').toBeGreaterThan(0);

    /**
     * Attribution: this run wrote one of the two, so the report says the run is involved. Worded
     * carefully, because the product cannot know which arrived first — only that one of them is its
     * own.
     */
    expect(found!.writtenByThisRun, 'how many of them this run wrote').toBe(1);
    expect(found!.attributable).toBe(true);

    expect(report.summary!.duplicateRecords).toBeGreaterThan(0);
    expect(
      entity.checks.find((c) => c.check === 'UNIQUENESS')!.outcome,
      'a duplicate this run is part of is a failure, not a note',
    ).toBe('FAIL');
  }, 900_000);
});
