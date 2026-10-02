import { describe, expect, it } from 'vitest';
import { UNIQUENESS_BASES, UNIQUENESS_LABELS, basisFor, describeUniqueness } from '../../shared/uniqueness';

/**
 * What a duplicate check is allowed to claim.
 *
 * The distinction these tests defend is the one a migration lead cares about: "we found no duplicate
 * primary keys" and "we found no duplicates" are different statements, and only one of them is about
 * the data. The target refuses a repeated primary key by itself, so a clean primary-key scan restates
 * the platform's guarantee.
 */
describe('what a duplicate scan proves', () => {
  it('refuses to let a primary-key scan count as business uniqueness', () => {
    const pk = describeUniqueness('PRIMARY_KEY', ['dtx_regionid']);

    expect(pk.enforcedByTarget).toBe(true);
    expect(pk.provesBusinessUniqueness).toBe(false);
    // The sentence has to say both halves: what was checked, and what that does not establish.
    expect(pk.proves).toContain('dtx_regionid');
    expect(pk.proves).toMatch(/does not show that the business data is unique/i);
    expect(pk.proves).toMatch(/alternate key or a business key/i);
  });

  it('treats a key the target enforces and a key we chose as different kinds of evidence', () => {
    const alternate = describeUniqueness('ALTERNATE_KEY', ['accountnumber']);
    const business = describeUniqueness('BUSINESS_KEY', ['productnumber']);

    // Both are real evidence about the data, unlike a primary key.
    expect(alternate.provesBusinessUniqueness).toBe(true);
    expect(business.provesBusinessUniqueness).toBe(true);
    // They differ in who guarantees it, which is why they are not one value.
    expect(alternate.enforcedByTarget).toBe(true);
    expect(business.enforcedByTarget).toBe(false);
    expect(business.proves).toMatch(/does not enforce/i);
  });

  it('says plainly when nothing was verified, and carries the reason', () => {
    const silent = describeUniqueness('NOT_VERIFIED', []);
    expect(silent.provesBusinessUniqueness).toBe(false);
    expect(silent.proves).toMatch(/No uniqueness was verified/i);

    const explained = describeUniqueness('NOT_VERIFIED', ['name'], {
      reason: 'The connector cannot group without reading the whole table.',
    });
    expect(explained.proves).toContain('cannot group without reading the whole table');
  });

  it('never leaves a basis without a label, so no report can render a bare enum', () => {
    for (const basis of UNIQUENESS_BASES) {
      expect(UNIQUENESS_LABELS[basis], basis).toBeTruthy();
      expect(describeUniqueness(basis, ['a']).proves.length, basis).toBeGreaterThan(20);
    }
  });
});

describe('choosing the basis from what the plan configured', () => {
  it('uses the business key the plan matched on, and marks several columns as composite', () => {
    expect(
      basisFor({
        matchStrategy: 'BUSINESS_KEY',
        businessKeyFields: ['productnumber'],
        alternateKeyColumns: [],
      }),
    ).toEqual({ basis: 'BUSINESS_KEY', columns: ['productnumber'] });

    expect(
      basisFor({
        matchStrategy: 'BUSINESS_KEY',
        businessKeyFields: ['country', 'taxid'],
        alternateKeyColumns: [],
      }),
    ).toEqual({ basis: 'COMPOSITE_BUSINESS_KEY', columns: ['country', 'taxid'] });
  });

  it('keeps a multi-column alternate key an alternate key, because the target still enforces it', () => {
    /**
     * The tempting simplification — "more than one column means composite" — would relabel a key the
     * target declares and enforces as columns we chose to group on ourselves, which is a weaker claim
     * than the truth.
     */
    const multi = basisFor({
      matchStrategy: 'ALTERNATE_KEY',
      businessKeyFields: [],
      alternateKeyColumns: ['country', 'registrationnumber'],
    })!;
    expect(multi.basis).toBe('ALTERNATE_KEY');
    expect(describeUniqueness(multi.basis, multi.columns).enforcedByTarget).toBe(true);
  });

  it('declines to invent an expectation when the plan configured none', () => {
    // PRIMARY_ID matching, or a strategy named without the fields to support it. The caller then
    // falls back to the primary key and must say so, rather than this guessing a business key.
    expect(
      basisFor({ matchStrategy: 'PRIMARY_ID', businessKeyFields: [], alternateKeyColumns: [] }),
    ).toBeNull();
    expect(
      basisFor({ matchStrategy: 'BUSINESS_KEY', businessKeyFields: [], alternateKeyColumns: [] }),
    ).toBeNull();
    expect(
      basisFor({ matchStrategy: 'ALTERNATE_KEY', businessKeyFields: ['ignored'], alternateKeyColumns: [] }),
    ).toBeNull();
    expect(basisFor({ matchStrategy: null, businessKeyFields: [], alternateKeyColumns: [] })).toBeNull();
  });
});
