import { describe, expect, it } from 'vitest';
import {
  addTotals,
  emptyComparisonTotals,
  fieldGaps,
  indexSide,
  keyOf,
  pairSides,
  renderKey,
  suggestFieldPairs,
  suggestKey,
  suggestTablePairs,
  totalsReconcile,
} from '../../server/src/services/data-comparison';
import { valuesEqual } from '../../server/src/services/values';
import type { AttributeMeta, DvRecord, TableMetadata, TableSummary } from '../../shared/metadata';

/**
 * Pairing two datasets.
 *
 * The value comparison is not tested here because it is not implemented here — it is
 * `compareRecords`, which the migration validation already uses and which has its own tests. What
 * is tested here is the half that is new: deciding which record on the left is the same thing as
 * which record on the right, and refusing to answer when the key cannot tell.
 */

const attr = (logicalName: string, over: Partial<AttributeMeta> = {}): AttributeMeta =>
  ({
    logicalName,
    schemaName: logicalName,
    displayName: logicalName,
    type: 'String',
    required: 'None',
    isPrimaryId: false,
    isPrimaryName: false,
    isCustom: false,
    isValidForCreate: true,
    isValidForUpdate: true,
    isValidForRead: true,
    isSecured: false,
    ...over,
  }) as AttributeMeta;

const table = (logicalName: string, attributes: AttributeMeta[], over: Partial<TableMetadata> = {}) =>
  ({
    logicalName,
    schemaName: logicalName,
    displayName: logicalName,
    primaryIdAttribute: 'id',
    primaryNameAttribute: 'name',
    isCustom: false,
    attributes,
    manyToOne: [],
    manyToMany: [],
    keys: [],
    ...over,
  }) as unknown as TableMetadata;

const rec = (id: string, values: Record<string, unknown>): DvRecord =>
  ({ id, values }) as unknown as DvRecord;

const CUSTOMER = table('customer', [
  attr('id', { isPrimaryId: true, type: 'Uniqueidentifier' }),
  attr('code'),
  attr('name'),
  attr('region'),
]);

/** Built rather than written literally, so the escape survives every tool that touches this file. */
const LF_TEXT = ['ACME', 'Ltd'].join('\n');
const CRLF_TEXT = ['ACME', 'Ltd'].join('\r\n');

describe('building the key', () => {
  const attrs = new Map(CUSTOMER.attributes.map((a) => [a.logicalName, a]));

  it('agrees with the value comparison about what counts as the same value', () => {
    // The invariant that matters, asserted directly rather than assumed: two values produce the
    // same key exactly when the value comparison calls them equal.
    //
    // If keys were trimmed more aggressively than values, two records would pair and then report
    // their own key column as a difference. If less, records the product considers identical would
    // be reported as existing on one side only. Either way the two halves of the same run would be
    // telling the user different stories about the same two records.
    const code = attrs.get('code')!;
    const pairs: [string, string][] = [
      ['ACME', 'ACME'],
      ['ACME ', 'ACME'],
      [' ACME', 'ACME'],
      ['ACME', 'acme'],
      [CRLF_TEXT, LF_TEXT],
    ];
    for (const [a, b] of pairs) {
      const sameKey =
        keyOf(rec('1', { code: a }), ['code'], attrs) === keyOf(rec('2', { code: b }), ['code'], attrs);
      expect(sameKey, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(valuesEqual(code, a, b));
    }
  });

  it('refuses a key that identifies nothing', () => {
    // A blank key is not a value. Treating it as one pairs every blank-keyed record with every
    // other blank-keyed record, which manufactures matches out of missing data.
    expect(keyOf(rec('1', { code: '' }), ['code'], attrs)).toBeNull();
    expect(keyOf(rec('1', { code: null }), ['code'], attrs)).toBeNull();
    expect(keyOf(rec('1', {}), ['code'], attrs)).toBeNull();
    // A composite key is unusable if any part is missing.
    expect(keyOf(rec('1', { code: 'ACME', region: '' }), ['code', 'region'], attrs)).toBeNull();
  });

  it('keeps composite parts separable and unambiguous', () => {
    const a = keyOf(rec('1', { code: 'AB', region: 'CD' }), ['code', 'region'], attrs)!;
    const b = keyOf(rec('2', { code: 'ABCD', region: '' }), ['code', 'region'], attrs);
    expect(a).not.toBe(b);
    expect(renderKey(a)).toBe('AB · CD');
  });

  it('refuses a key column that does not exist rather than keying on undefined', () => {
    expect(keyOf(rec('1', { code: 'ACME' }), ['nonexistent'], attrs)).toBeNull();
  });
});

describe('indexing one side', () => {
  it('excludes every record sharing a key, not just the later one', () => {
    // Keeping the first would report a comparison result for a record chosen by read order.
    const side = indexSide(
      [rec('1', { code: 'A' }), rec('2', { code: 'B' }), rec('3', { code: 'B' }), rec('4', { code: '' })],
      ['code'],
      CUSTOMER,
    );
    expect([...side.byKey.keys()]).toEqual(['A']);
    expect(side.duplicates.get('B')).toBe(2);
    expect(side.blank).toHaveLength(1);
    expect(side.total).toBe(4);
    // Two duplicates and one blank: three records that cannot be paired.
    expect(side.excluded).toBe(3);
  });
});

describe('pairing the two sides', () => {
  const left = indexSide([rec('l1', { code: 'A' }), rec('l2', { code: 'B' })], ['code'], CUSTOMER);

  it('pairs by key and reports a left record with no partner', () => {
    const right = indexSide([rec('r1', { code: 'A' })], ['code'], CUSTOMER);
    const { pairs, onlyInRight } = pairSides(left, right);
    expect(pairs.find((p) => p.key === 'A')?.right?.id).toBe('r1');
    expect(pairs.find((p) => p.key === 'B')?.right).toBeNull();
    expect(onlyInRight).toHaveLength(0);
  });

  it('reports a right record with no partner', () => {
    const right = indexSide([rec('r1', { code: 'A' }), rec('r9', { code: 'Z' })], ['code'], CUSTOMER);
    expect(pairSides(left, right).onlyInRight.map((r) => r.key)).toEqual(['Z']);
  });

  it('does not call a key "only on the right" when the left simply could not answer', () => {
    // The left has that key twice, so it was excluded. Saying the record exists on one side only
    // would be a second wrong answer stacked on the first.
    const ambiguous = indexSide([rec('l1', { code: 'A' }), rec('l2', { code: 'A' })], ['code'], CUSTOMER);
    const right = indexSide([rec('r1', { code: 'A' })], ['code'], CUSTOMER);
    expect(pairSides(ambiguous, right).onlyInRight).toEqual([]);
  });
});

describe('the totals identity', () => {
  it('holds for a realistic mix, and fails when a record goes missing', () => {
    const totals = {
      ...emptyComparisonTotals(),
      leftRecords: 100,
      rightRecords: 90,
      leftExcluded: 4,
      rightExcluded: 2,
      matched: 80,
      different: 6,
      onlyInLeft: 10,
      onlyInRight: 2,
    };
    expect(totalsReconcile(totals)).toBe(true);
    // One record quietly dropped between reading and reporting: the arithmetic catches it, which
    // is the entire reason the totals are shaped this way.
    expect(totalsReconcile({ ...totals, matched: 79 })).toBe(false);
    expect(totalsReconcile({ ...totals, leftRecords: 101 })).toBe(false);
  });

  it('adds up across tables without losing the identity', () => {
    const one = {
      ...emptyComparisonTotals(),
      leftRecords: 10,
      rightRecords: 10,
      matched: 9,
      different: 1,
    };
    const both = addTotals(one, one);
    expect(both.matched).toBe(18);
    expect(totalsReconcile(both)).toBe(true);
  });
});

describe('proposing what to compare', () => {
  const summary = (logicalName: string, displayName: string) =>
    ({ logicalName, schemaName: logicalName, displayName }) as TableSummary;

  it('pairs tables across naming conventions, and each right table only once', () => {
    const pairs = suggestTablePairs(
      [summary('dbo.Customer', 'Customer'), summary('dbo.Order', 'Order')],
      [summary('account', 'Account'), summary('customer', 'Customer'), summary('order', 'Order')],
    );
    const byLeft = new Map(pairs.map((p) => [p.left.logicalName, p.right.logicalName]));
    expect(byLeft.get('dbo.Customer')).toBe('customer');
    expect(byLeft.get('dbo.Order')).toBe('order');
    expect(new Set(pairs.map((p) => p.right.logicalName)).size).toBe(pairs.length);
  });

  it('proposes a key only when a column is actually unique on both sides', () => {
    // Where both sides share a primary id, that is the strongest identifier available.
    const withBoth = table('customer', [attr('id', { isPrimaryId: true }), attr('code'), attr('name')], {
      keys: [{ logicalName: 'k', schemaName: 'k', displayName: 'k', attributes: ['code'] }],
    });
    expect(suggestKey(withBoth, withBoth)).toEqual([{ left: 'id', right: 'id' }]);

    // Across two different systems the primary ids rarely share a name, and then a unique business
    // key is what identifies the same real-world record.
    const sqlSide = table('dbo.Customer', [attr('CustomerId', { isPrimaryId: true }), attr('code')], {
      keys: [{ logicalName: 'k', schemaName: 'k', displayName: 'k', attributes: ['code'] }],
    });
    const dvSide = table('account', [attr('accountid', { isPrimaryId: true }), attr('code')], {
      keys: [{ logicalName: 'k', schemaName: 'k', displayName: 'k', attributes: ['code'] }],
    });
    expect(suggestKey(sqlSide, dvSide)).toEqual([{ left: 'code', right: 'code' }]);

    // A column that is merely present on both sides is not a key. Guessing one produces a
    // comparison that is confidently wrong, so it proposes nothing and asks.
    const noKey = table('customer', [attr('name'), attr('region')]);
    expect(suggestKey(noKey, noKey)).toEqual([]);
  });

  it('ignores an alternate key whose unique index is not in place yet', () => {
    const pending = table('customer', [attr('code')], {
      keys: [
        { logicalName: 'k', schemaName: 'k', displayName: 'k', attributes: ['code'], status: 'Pending' },
      ],
    });
    expect(suggestKey(pending, pending)).toEqual([]);
  });

  it('pairs fields by name and leaves out the columns that always differ', () => {
    const left = table('a', [attr('name'), attr('region'), attr('modifiedon', { type: 'DateTime' })]);
    const right = table('b', [attr('name'), attr('region'), attr('modifiedon', { type: 'DateTime' })]);
    const fields = suggestFieldPairs(left, right).map((f) => f.left);
    expect(fields).toContain('name');
    // Audit columns differ by design; including them would bury the real findings.
    expect(fields).not.toContain('modifiedon');
  });

  it('names the columns that exist on one side only', () => {
    const left = table('a', [attr('name'), attr('region')]);
    const right = table('b', [attr('name'), attr('phone')]);
    expect(fieldGaps(left, right)).toEqual({ onlyInLeft: ['region'], onlyInRight: ['phone'] });
  });
});
