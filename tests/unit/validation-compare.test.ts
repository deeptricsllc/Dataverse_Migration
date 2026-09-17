import { describe, expect, it } from 'vitest';
import {
  displayValue,
  normalizeForCompare,
  transformValue,
  valuesEqual,
} from '../../server/src/services/values';
import { compareRecords } from '../../server/src/services/validation-service';
import { attr, lookup, table } from './fixtures';

describe('value normalization', () => {
  it('ignores formatting-only differences', () => {
    expect(valuesEqual(attr('s', 'String'), 'a\r\nb  ', 'a\nb')).toBe(true);
    expect(valuesEqual(attr('s', 'String'), '', null)).toBe(true);
    expect(valuesEqual(attr('m', 'Money', { precision: 2 }), 10.004, 10)).toBe(true);
    expect(valuesEqual(attr('m', 'Money', { precision: 2 }), 10.02, 10)).toBe(false);
    expect(valuesEqual(attr('d', 'DateTime'), '2026-01-01T10:00:00Z', '2026-01-01T10:00:00.000Z')).toBe(true);
    expect(
      valuesEqual(
        attr('d', 'DateTime', { dateTimeBehavior: 'DateOnly' }),
        '2026-01-01',
        '2026-01-01T00:00:00Z',
      ),
    ).toBe(true);
    expect(valuesEqual(attr('g', 'Uniqueidentifier'), 'ABC', 'abc')).toBe(true);
    expect(normalizeForCompare(attr('ms', 'MultiSelectPicklist'), [3, 1])).toBe('1,3');
  });

  it('converts values for the target type', () => {
    expect(transformValue(attr('a', 'Integer'), attr('a', 'Decimal', { precision: 1 }), 3)).toEqual({
      ok: true,
      value: 3,
    });
    expect(transformValue(attr('a', 'Decimal'), attr('a', 'Money', { precision: 2 }), 1.2345)).toEqual({
      ok: true,
      value: 1.23,
    });
    expect(transformValue(attr('a', 'String'), attr('a', 'Integer'), 'abc')).toMatchObject({ ok: false });
    expect(
      transformValue(
        attr('a', 'DateTime'),
        attr('a', 'DateTime', { dateTimeBehavior: 'DateOnly' }),
        '2024-02-03T10:00:00Z',
      ),
    ).toEqual({ ok: true, value: '2024-02-03' });
  });

  it('masks secured values and truncates long values in reports', () => {
    expect(displayValue(attr('s', 'String', { isSecured: true }), 'secret')).toMatch(/secured/);
    expect(displayValue(attr('s', 'String'), 'x'.repeat(300))!.length).toBeLessThan(300);
  });
});

describe('field-level validation comparison', () => {
  const src = table('contact', [attr('name', 'String'), lookup('accountid', ['account'])]);
  const tgt = table('contact', [attr('name', 'String'), lookup('accountid', ['account'])]);
  const mappings = [
    { sourceField: 'name', targetField: 'name', isLookup: false },
    { sourceField: 'accountid', targetField: 'accountid', isLookup: true },
  ];
  const acc = (id: string) => ({ id, logicalName: 'account' });

  it('counts matched, missing and different records and resolves lookups via identity map', () => {
    const result = compareRecords({
      source: src,
      target: tgt,
      mappings,
      expectedLookup: (_l, id) => (id === 'src-acc' ? 'tgt-acc' : null),
      pairs: [
        {
          source: { id: '1', values: { name: 'Ann', accountid: acc('src-acc') } },
          target: { id: '1', values: { name: 'Ann ', accountid: acc('TGT-ACC') } },
          outcome: 'CREATED',
        },
        {
          source: { id: '2', values: { name: 'Bob', accountid: null } },
          target: { id: '2', values: { name: 'Robert', accountid: null } },
          outcome: 'CREATED',
        },
        {
          source: { id: '3', values: { name: 'Cy', accountid: acc('src-acc') } },
          target: { id: '3', values: { name: 'Cy', accountid: acc('other') } },
          outcome: 'UPDATED',
        },
        { source: { id: '4', values: { name: 'Di', accountid: null } }, target: null, outcome: 'CREATED' },
        {
          source: { id: '5', values: { name: 'Ed', accountid: null } },
          target: { id: '5', values: { name: 'Edward', accountid: null } },
          outcome: 'SKIPPED',
        },
      ],
    });
    expect(result).toMatchObject({ matched: 1, missing: 1, different: 3 });
    const types = result.diffs.map((d) => `${d.sourceRecordId}:${d.differenceType}:${d.outcome}`);
    expect(types).toEqual([
      '2:VALUE_MISMATCH:FAIL',
      '3:LOOKUP_MISMATCH:FAIL',
      '4:MISSING_IN_TARGET:FAIL',
      '5:PRE_EXISTING_DIFFERENCE:WARNING',
    ]);
  });
});
