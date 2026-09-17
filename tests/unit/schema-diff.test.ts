import { describe, expect, it } from 'vitest';
import { compareSchemas, diffColumn, diffKeys, diffTableDeep } from '../../server/src/services/schema-diff';
import { attr, lookup, table } from './fixtures';

describe('schema diff engine', () => {
  it('classifies identical columns as MATCH', () => {
    const a = attr('name', 'String', { maxLength: 100 });
    expect(diffColumn(a, { ...a }).status).toBe('MATCH');
  });

  it('classifies source-only and target-only columns', () => {
    expect(diffColumn(attr('x', 'String'), undefined).status).toBe('SOURCE_ONLY');
    expect(diffColumn(undefined, attr('x', 'String')).status).toBe('TARGET_ONLY');
  });

  it('flags incompatible types', () => {
    const d = diffColumn(attr('w', 'String'), attr('w', 'Integer'));
    expect(d.status).toBe('INCOMPATIBLE');
    expect(d.differences[0]).toMatchObject({ property: 'type', breaking: true });
  });

  it('treats widening numeric conversions as compatible differences', () => {
    const d = diffColumn(attr('n', 'Integer'), attr('n', 'Decimal', { precision: 2 }));
    expect(d.status).toBe('DIFFERENT');
    expect(d.differences.find((x) => x.property === 'type')!.breaking).toBe(false);
  });

  it('marks shorter target max length and stricter requirement as breaking', () => {
    const d = diffColumn(
      attr('s', 'String', { maxLength: 200 }),
      attr('s', 'String', { maxLength: 100, requiredLevel: 'ApplicationRequired' }),
    );
    expect(d.status).toBe('DIFFERENT');
    expect(d.differences.find((x) => x.property === 'maxLength')!.breaking).toBe(true);
    expect(d.differences.find((x) => x.property === 'requiredLevel')!.breaking).toBe(true);
  });

  it('compares choice options', () => {
    const src = attr('c', 'Picklist', {
      options: [
        { value: 1, label: 'A' },
        { value: 2, label: 'B' },
      ],
    });
    const tgt = attr('c', 'Picklist', {
      options: [
        { value: 1, label: 'A1' },
        { value: 3, label: 'C' },
      ],
    });
    const d = diffColumn(src, tgt);
    expect(d.optionDiff).toEqual({
      sourceOnly: [{ value: 2, label: 'B' }],
      targetOnly: [{ value: 3, label: 'C' }],
      labelChanged: [1],
    });
    expect(d.differences.find((x) => x.property === 'options')!.breaking).toBe(true);
  });

  it('detects incompatible lookup targets', () => {
    const d = diffColumn(lookup('p', ['account']), lookup('p', ['contact']));
    expect(d.status).toBe('INCOMPATIBLE');
  });

  it('compares relationships and alternate keys', () => {
    const s = table('account', [lookup('parentid', ['account'])], {
      keys: [{ logicalName: 'k1', schemaName: 'k1', displayName: 'k1', attributes: ['a', 'b'] }],
    });
    const t = table('account', [], {
      keys: [{ logicalName: 'k1', schemaName: 'k1', displayName: 'k1', attributes: ['b'] }],
    });
    const d = diffTableDeep(s, t);
    expect(d.relationships[0].status).toBe('SOURCE_ONLY');
    expect(diffKeys(s, t)[0].status).toBe('DIFFERENT');
    expect(d.status).toBe('DIFFERENT');
  });

  it('ignores computed shadow columns', () => {
    const s = table('x', [attr('ownername', 'String', { attributeOf: 'ownerid' })]);
    const t = table('x', []);
    expect(diffTableDeep(s, t).status).toBe('MATCH');
  });

  it('summarizes catalog-level comparison', () => {
    const acc = table('account', [attr('name', 'String')]);
    const result = compareSchemas({
      sourceCatalog: [acc, table('legacy', [])],
      targetCatalog: [acc, table('newone', [])],
      sourceDeep: new Map([['account', acc]]),
      targetDeep: new Map([['account', acc]]),
    });
    expect(result.summary).toMatchObject({
      tablesCompared: 3,
      match: 1,
      sourceOnly: 1,
      targetOnly: 1,
      deepCompared: 1,
    });
  });
});
