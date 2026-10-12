import { describe, expect, it } from 'vitest';
import type { AttributeMeta, TableMetadata } from '../../shared/metadata';
import { compareRecords } from '../../server/src/services/validation-service';
import { MAX_BINARY_COMPARE_BYTES, compareValues } from '../../server/src/services/values';

/**
 * The third answer: a column the platform cannot honestly compare.
 *
 * Before this, every comparison had to come out equal or different. A JSON document with a repeated
 * key and a binary value too large to read are neither, and calling them equal is a silent false
 * pass — the one failure mode this product exists to avoid.
 *
 * Which columns get the treatment is decided by the **target** column, because comparison is in the
 * target's terms: a `jsonb` source column migrated into a Dataverse Memo is text now, and comparing it
 * as text is right.
 */

const attr = (over: Partial<AttributeMeta> = {}): AttributeMeta =>
  ({
    logicalName: 'payload',
    displayName: 'Payload',
    type: 'String',
    isPrimaryId: false,
    isPrimaryName: false,
    requiredLevel: 'None',
    isValidForCreate: true,
    isValidForUpdate: true,
    isSecured: false,
    ...over,
  }) as AttributeMeta;

const jsonColumn = (dataType = 'jsonb') =>
  attr({
    type: 'Memo',
    sql: {
      dataType,
      maxLength: null,
      precision: null,
      scale: null,
      isNullable: true,
      isIdentity: false,
      isComputed: false,
      isRowVersion: false,
      defaultDefinition: null,
    } as never,
  });

const binaryColumn = (dataType = 'varbinary') =>
  attr({
    type: 'Other',
    sql: {
      dataType,
      maxLength: -1,
      precision: null,
      scale: null,
      isNullable: true,
      isIdentity: false,
      isComputed: false,
      isRowVersion: false,
      defaultDefinition: null,
    } as never,
  });

describe('a JSON target column is compared as a document', () => {
  it('calls the same document with reordered keys equal, which text comparison could not', () => {
    const column = jsonColumn();
    expect(compareValues(column, '{"a":1,"b":2}', '{"b":2,"a":1}')).toEqual({ verdict: 'EQUAL' });
    // The old behaviour, still correct for a text column: the target's terms decide.
    expect(compareValues(attr({ type: 'Memo' }), '{"a":1,"b":2}', '{"b":2,"a":1}').verdict).toBe('DIFFERENT');
  });

  it('works for json as well as jsonb, and is case-insensitive about the type name', () => {
    for (const type of ['json', 'jsonb', 'JSONB', 'Json']) {
      expect(compareValues(jsonColumn(type), '{"a":1,"b":2}', '{"b":2,"a":1}').verdict, type).toBe('EQUAL');
    }
  });

  it('says NOT_COMPARABLE for a document whose keys repeat, instead of letting a parser decide', () => {
    const result = compareValues(jsonColumn(), '{"a":1,"a":2}', '{"a":2}');
    expect(result.verdict).toBe('NOT_COMPARABLE');
    expect(result.reason).toMatch(/repeats the key/);
  });

  it('treats an absent document and a present one as different, including JSON null', () => {
    const column = jsonColumn();
    expect(compareValues(column, null, '{"a":1}').verdict).toBe('DIFFERENT');
    expect(compareValues(column, '{"a":1}', null).verdict).toBe('DIFFERENT');
    expect(compareValues(column, null, null).verdict).toBe('EQUAL');
    expect(compareValues(column, undefined, null).verdict).toBe('EQUAL');
    // SQL NULL and the JSON document `null` are two different things in a jsonb column.
    expect(compareValues(column, null, 'null').verdict).toBe('DIFFERENT');
  });

  it('compares an already-parsed value, which is what most drivers hand back', () => {
    const column = jsonColumn();
    // pg returns jsonb as a parsed object. Key order is then whatever the object has.
    expect(compareValues(column, { b: 2, a: 1 } as never, '{"a":1,"b":2}').verdict).toBe('EQUAL');
    expect(compareValues(column, { a: 1 } as never, { a: 1 } as never).verdict).toBe('EQUAL');
    expect(compareValues(column, { a: 1 } as never, { a: 2 } as never).verdict).toBe('DIFFERENT');
  });
});

describe('a binary target column is compared byte for byte, within a limit', () => {
  it('compares buffers exactly', () => {
    const column = binaryColumn();
    const a = Uint8Array.from([1, 2, 3]);
    expect(compareValues(column, a as never, Uint8Array.from([1, 2, 3]) as never).verdict).toBe('EQUAL');
    expect(compareValues(column, a as never, Uint8Array.from([1, 2, 4]) as never).verdict).toBe('DIFFERENT');
    // A length difference is what a truncation looks like, and is provable without reading further.
    expect(compareValues(column, a as never, Uint8Array.from([1, 2]) as never).verdict).toBe('DIFFERENT');
  });

  it('reconciles the encodings different connectors return for the same bytes', () => {
    const column = binaryColumn();
    const bytes = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    expect(compareValues(column, bytes as never, '3q2+7w==').verdict, 'buffer vs base64').toBe('EQUAL');
    expect(compareValues(column, '\\xdeadbeef', bytes as never).verdict, 'bytea hex vs buffer').toBe('EQUAL');
    expect(compareValues(column, '\\xdeadbeef', '3q2+7w==').verdict, 'hex vs base64').toBe('EQUAL');
    expect(compareValues(column, '\\xdeadbeef', '\\xdeadbeee').verdict).toBe('DIFFERENT');
  });

  it('declines a value past the size limit rather than reading it to answer one question', () => {
    const column = binaryColumn();
    const huge = new Uint8Array(MAX_BINARY_COMPARE_BYTES + 1);
    const result = compareValues(column, huge as never, Uint8Array.from([1]) as never);
    expect(result.verdict).toBe('NOT_COMPARABLE');
    expect(result.reason).toMatch(/past the .*comparison limit/);
  });

  it('declines text it cannot read as bytes, instead of comparing it as text', () => {
    const result = compareValues(binaryColumn(), 'not bytes at all!', '3q2+7w==');
    expect(result.verdict).toBe('NOT_COMPARABLE');
    expect(result.reason).toMatch(/does not recognize as bytes/);
  });

  it('recognises the binary types each engine and Dataverse actually use', () => {
    for (const type of ['varbinary', 'binary', 'bytea', 'blob', 'longblob', 'image']) {
      expect(compareValues(binaryColumn(type), '\\xaa', '\\xab').verdict, type).toBe('DIFFERENT');
    }
    for (const type of ['File', 'Image'] as const) {
      expect(compareValues(attr({ type }), '\\xaa', '\\xab').verdict, type).toBe('DIFFERENT');
    }
  });
});

describe('what a report says about a column it could not compare', () => {
  const table = (attributes: AttributeMeta[]): TableMetadata =>
    ({
      logicalName: 'thing',
      displayName: 'Thing',
      primaryIdAttribute: 'id',
      primaryNameAttribute: 'name',
      attributes: [attr({ logicalName: 'id', type: 'Uniqueidentifier', isPrimaryId: true }), ...attributes],
      keys: [],
      relationships: [],
    }) as unknown as TableMetadata;

  const compare = (sourceValue: unknown, targetValue: unknown, column: AttributeMeta) =>
    compareRecords({
      source: table([attr({ logicalName: 'payload', type: 'Memo' })]),
      target: table([column]),
      mappings: [{ sourceField: 'payload', targetField: 'payload', isLookup: false }],
      pairs: [
        {
          source: { id: 's1', logicalName: 'thing', values: { payload: sourceValue } } as never,
          target: { id: 't1', logicalName: 'thing', values: { payload: targetValue } } as never,
          outcome: 'CREATED',
        },
      ],
      expectedLookup: () => null,
    });

  it('counts the record as matched, names the column, and reports no difference', () => {
    /**
     * The record was compared on everything else and nothing was found wrong with it, so calling it
     * "different" would report a problem nobody has shown. The limit is on the column, and that is
     * where it is reported — with the reason, and how many records it affected.
     */
    const result = compare('{"a":1,"a":2}', '{"a":2}', jsonColumn());

    expect(result.different, 'nothing was shown to differ').toBe(0);
    expect(result.diffs, 'and no difference row was invented').toEqual([]);
    expect(result.matched).toBe(1);
    expect(result.uncompared).toHaveLength(1);
    expect(result.uncompared[0]!.field).toBe('payload');
    expect(result.uncompared[0]!.records).toBe(1);
    expect(result.uncompared[0]!.reason).toMatch(/repeats the key/);
  });

  it('still reports a real difference on the same kind of column', () => {
    const result = compare('{"a":1}', '{"a":2}', jsonColumn());
    expect(result.different).toBe(1);
    expect(result.uncompared).toEqual([]);
  });

  it('reports nothing at all when every column could be compared', () => {
    const result = compare('{"a":1,"b":2}', '{"b":2,"a":1}', jsonColumn());
    expect(result.matched).toBe(1);
    expect(result.different).toBe(0);
    expect(result.uncompared).toEqual([]);
  });
});
