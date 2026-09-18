import { describe, expect, it } from 'vitest';
import type { AttributeMeta, FieldValue } from '../../shared/metadata';
import {
  classifyCrossProviderCompatibility,
  convertValue,
  sqlCharLength,
  sqlDateTimeBehavior,
  sqlIntegerRange,
  sqlToAttributeType,
  SQL_UNSUPPORTED_TYPES,
} from '../../server/src/connectors/sql/type-map';
import { attr } from './fixtures';

/** An attribute as the SQL catalog would produce it. */
function sqlAttr(
  name: string,
  dataType: string,
  type: AttributeMeta['type'],
  extra: Partial<AttributeMeta> = {},
): AttributeMeta {
  return attr(name, type, {
    rawType: dataType,
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
      collation: null,
      ...(extra.sql ?? {}),
    },
    ...extra,
  });
}

const text = (name: string, chars: number | null, dataType = 'nvarchar') =>
  sqlAttr(name, dataType, chars === null || chars > 4000 ? 'Memo' : 'String', {
    maxLength: chars,
    sql: {
      dataType,
      maxLength: chars ?? -1,
      precision: null,
      scale: null,
      isNullable: true,
      isIdentity: false,
      isComputed: false,
      isRowVersion: false,
      defaultDefinition: null,
      collation: null,
    },
  });

const dec = (name: string, precision: number, scale: number) =>
  sqlAttr(name, 'decimal', 'Decimal', {
    precision: scale,
    sql: {
      dataType: 'decimal',
      maxLength: null,
      precision,
      scale,
      isNullable: true,
      isIdentity: false,
      isComputed: false,
      isRowVersion: false,
      defaultDefinition: null,
      collation: null,
    },
  });

describe('sqlToAttributeType', () => {
  it('maps character types by length, with MAX becoming Memo', () => {
    expect(sqlToAttributeType('nvarchar', null, null, 100)).toBe('String');
    expect(sqlToAttributeType('varchar', null, null, 4000)).toBe('String');
    expect(sqlToAttributeType('varchar', null, null, 8000)).toBe('Memo');
    expect(sqlToAttributeType('nvarchar', null, null, -1)).toBe('Memo');
    expect(sqlToAttributeType('char', null, null, 2)).toBe('String');
    expect(sqlToAttributeType('nchar', null, null, 10)).toBe('String');
  });

  it('maps the legacy and markup text types to Memo', () => {
    for (const t of ['text', 'ntext', 'xml']) {
      expect(sqlToAttributeType(t, null, null, -1)).toBe('Memo');
    }
  });

  it('maps numeric families', () => {
    expect(sqlToAttributeType('bit', null, null, null)).toBe('Boolean');
    expect(sqlToAttributeType('tinyint', 3, 0, null)).toBe('Integer');
    expect(sqlToAttributeType('smallint', 5, 0, null)).toBe('Integer');
    expect(sqlToAttributeType('int', 10, 0, null)).toBe('Integer');
    expect(sqlToAttributeType('bigint', 19, 0, null)).toBe('BigInt');
    expect(sqlToAttributeType('decimal', 18, 4, null)).toBe('Decimal');
    expect(sqlToAttributeType('numeric', 9, 2, null)).toBe('Decimal');
    expect(sqlToAttributeType('money', 19, 4, null)).toBe('Money');
    expect(sqlToAttributeType('smallmoney', 10, 4, null)).toBe('Money');
    expect(sqlToAttributeType('float', 53, null, null)).toBe('Double');
    expect(sqlToAttributeType('real', 24, null, null)).toBe('Double');
  });

  it('maps date, time, identifier and opaque types', () => {
    expect(sqlToAttributeType('date', null, null, null)).toBe('DateTime');
    expect(sqlToAttributeType('datetime', null, null, null)).toBe('DateTime');
    expect(sqlToAttributeType('datetime2', null, 7, null)).toBe('DateTime');
    expect(sqlToAttributeType('smalldatetime', null, null, null)).toBe('DateTime');
    expect(sqlToAttributeType('datetimeoffset', null, 7, null)).toBe('DateTime');
    expect(sqlToAttributeType('time', null, 7, null)).toBe('Other');
    expect(sqlToAttributeType('uniqueidentifier', null, null, null)).toBe('Uniqueidentifier');
    for (const t of ['binary', 'varbinary', 'image', 'timestamp', 'rowversion', 'sql_variant']) {
      expect(sqlToAttributeType(t, null, null, -1)).toBe('Other');
    }
    for (const t of ['geography', 'geometry', 'hierarchyid']) {
      expect(sqlToAttributeType(t, null, null, -1)).toBe('Other');
    }
  });

  it('is case insensitive about the type name', () => {
    expect(sqlToAttributeType('NVarChar', null, null, 50)).toBe('String');
    expect(sqlToAttributeType(' BIGINT ', null, null, null)).toBe('BigInt');
  });

  it('lists every unmovable type', () => {
    expect([...SQL_UNSUPPORTED_TYPES].sort()).toEqual(
      [
        'binary',
        'geography',
        'geometry',
        'hierarchyid',
        'image',
        'rowversion',
        'sql_variant',
        'timestamp',
        'varbinary',
      ].sort(),
    );
  });
});

describe('sql length, range and date behavior helpers', () => {
  it('converts unicode byte lengths to characters and preserves MAX', () => {
    expect(sqlCharLength('nvarchar', 200)).toBe(100);
    expect(sqlCharLength('varchar', 200)).toBe(200);
    expect(sqlCharLength('nchar', 20)).toBe(10);
    expect(sqlCharLength('nvarchar', -1)).toBe(-1);
    expect(sqlCharLength('int', null)).toBeNull();
  });

  it('reports integer bounds only for integral types', () => {
    expect(sqlIntegerRange('tinyint')).toEqual({ min: 0, max: 255 });
    expect(sqlIntegerRange('int')).toEqual({ min: -2147483648, max: 2147483647 });
    expect(sqlIntegerRange('decimal')).toBeNull();
  });

  it('marks date as DateOnly and zone-less types as TimeZoneIndependent', () => {
    expect(sqlDateTimeBehavior('date')).toBe('DateOnly');
    expect(sqlDateTimeBehavior('datetime2')).toBe('TimeZoneIndependent');
    expect(sqlDateTimeBehavior('datetimeoffset')).toBe('UserLocal');
    expect(sqlDateTimeBehavior('int')).toBeNull();
  });
});

describe('classifyCrossProviderCompatibility', () => {
  it('accepts identical types', () => {
    expect(classifyCrossProviderCompatibility(text('a', 100), text('a', 100)).status).toBe('COMPATIBLE');
    expect(
      classifyCrossProviderCompatibility(
        sqlAttr('d', 'datetime2', 'DateTime'),
        sqlAttr('d', 'datetime2', 'DateTime'),
      ).status,
    ).toBe('COMPATIBLE');
  });

  it('flags a shorter text target as lossy and names the limit', () => {
    const c = classifyCrossProviderCompatibility(text('a', 200), text('a', 50));
    expect(c.status).toBe('LOSSY');
    expect(c.reason).toBe('values longer than 50 characters will be truncated');
  });

  it('treats an unbounded text target as compatible and an unbounded source into a fixed target as lossy', () => {
    expect(classifyCrossProviderCompatibility(text('a', 200), text('a', null)).status).toBe('COMPATIBLE');
    expect(classifyCrossProviderCompatibility(text('a', null), text('a', 100)).status).toBe('LOSSY');
  });

  it('requires a conversion from text into scalars', () => {
    for (const target of [
      sqlAttr('n', 'int', 'Integer'),
      sqlAttr('b', 'bit', 'Boolean'),
      sqlAttr('d', 'date', 'DateTime'),
    ]) {
      const c = classifyCrossProviderCompatibility(text('s', 50), target);
      expect(c.status).toBe('CONVERSION_REQUIRED');
      expect(c.reason).toMatch(/parsed/);
    }
  });

  it('widens integers without loss and narrows them lossily', () => {
    const int = sqlAttr('n', 'int', 'Integer');
    const big = sqlAttr('n', 'bigint', 'BigInt');
    expect(classifyCrossProviderCompatibility(int, dec('n', 18, 4)).status).toBe('COMPATIBLE');
    expect(classifyCrossProviderCompatibility(int, sqlAttr('n', 'float', 'Double')).status).toBe(
      'COMPATIBLE',
    );
    expect(classifyCrossProviderCompatibility(int, sqlAttr('n', 'money', 'Money')).status).toBe('COMPATIBLE');
    expect(classifyCrossProviderCompatibility(int, big).status).toBe('COMPATIBLE');

    const overflow = classifyCrossProviderCompatibility(big, int);
    expect(overflow.status).toBe('LOSSY');
    expect(overflow.reason).toMatch(/overflow/);

    const scaleLoss = classifyCrossProviderCompatibility(dec('n', 18, 4), int);
    expect(scaleLoss.status).toBe('LOSSY');
    expect(scaleLoss.reason).toMatch(/fractional/);
    expect(classifyCrossProviderCompatibility(sqlAttr('n', 'float', 'Double'), int).status).toBe('LOSSY');
  });

  it('detects decimal precision and scale reductions', () => {
    expect(classifyCrossProviderCompatibility(dec('n', 18, 4), dec('n', 18, 2)).reason).toMatch(
      /2 decimal places/,
    );
    expect(classifyCrossProviderCompatibility(dec('n', 18, 4), dec('n', 18, 2)).status).toBe('LOSSY');
    expect(classifyCrossProviderCompatibility(dec('n', 18, 2), dec('n', 9, 2)).status).toBe('LOSSY');
    expect(classifyCrossProviderCompatibility(dec('n', 9, 2), dec('n', 18, 4)).status).toBe('COMPATIBLE');
  });

  it('requires a choice mapping for any picklist, state or status target', () => {
    for (const t of ['Picklist', 'State', 'Status'] as const) {
      const c = classifyCrossProviderCompatibility(text('s', 50), attr('c', t));
      expect(c.status).toBe('CONVERSION_REQUIRED');
      expect(c.reason).toMatch(/choice mapping is required/);
    }
    expect(
      classifyCrossProviderCompatibility(sqlAttr('n', 'int', 'Integer'), attr('c', 'Picklist')).status,
    ).toBe('CONVERSION_REQUIRED');
  });

  it('routes identifiers and keys into lookups through the identity map', () => {
    const guid = sqlAttr('id', 'uniqueidentifier', 'Uniqueidentifier');
    for (const t of ['Lookup', 'Customer', 'Owner'] as const) {
      const c = classifyCrossProviderCompatibility(guid, attr('l', t, { targets: ['account'] }));
      expect(c.status).toBe('CONVERSION_REQUIRED');
      expect(c.reason).toMatch(/record identity map/);
    }
    for (const src of [sqlAttr('n', 'int', 'Integer'), sqlAttr('n', 'bigint', 'BigInt'), text('s', 50)]) {
      expect(
        classifyCrossProviderCompatibility(src, attr('l', 'Lookup', { targets: ['account'] })).status,
      ).toBe('CONVERSION_REQUIRED');
    }
    expect(
      classifyCrossProviderCompatibility(
        sqlAttr('d', 'datetime', 'DateTime'),
        attr('l', 'Lookup', { targets: ['account'] }),
      ).status,
    ).toBe('INCOMPATIBLE');
  });

  it('refuses binary and spatial source columns outright', () => {
    for (const t of ['varbinary', 'image', 'geography', 'hierarchyid', 'timestamp']) {
      const src = sqlAttr('blob', t, 'Other');
      const c = classifyCrossProviderCompatibility(src, sqlAttr('blob', t, 'Other'));
      expect(c.status).toBe('INCOMPATIBLE');
      expect(c.reason).toContain(t);
    }
  });

  it('treats bit and int as a conversion in both directions', () => {
    const bit = sqlAttr('flag', 'bit', 'Boolean');
    const int = sqlAttr('flag', 'int', 'Integer');
    expect(classifyCrossProviderCompatibility(bit, int)).toMatchObject({ status: 'CONVERSION_REQUIRED' });
    expect(classifyCrossProviderCompatibility(int, bit)).toMatchObject({ status: 'CONVERSION_REQUIRED' });
  });

  it('formats scalars into text as a conversion', () => {
    expect(classifyCrossProviderCompatibility(sqlAttr('n', 'int', 'Integer'), text('s', 50)).status).toBe(
      'CONVERSION_REQUIRED',
    );
  });

  it('names both types when nothing else applies', () => {
    const c = classifyCrossProviderCompatibility(
      sqlAttr('d', 'datetime', 'DateTime'),
      sqlAttr('n', 'int', 'Integer'),
    );
    expect(c.status).toBe('INCOMPATIBLE');
    expect(c.reason).toBe('DateTime cannot be converted to Integer');
  });
});

describe('convertValue', () => {
  const src = text('s', 200);

  const ok = (r: ReturnType<typeof convertValue>): FieldValue => {
    expect(r.ok).toBe(true);
    return (r as { ok: true; value: FieldValue }).value;
  };
  const err = (r: ReturnType<typeof convertValue>): string => {
    expect(r.ok).toBe(false);
    return (r as { ok: false; error: string }).error;
  };

  it('passes null through for an optional target', () => {
    expect(ok(convertValue(null, src, text('t', 50)))).toBeNull();
  });

  it('refuses null for a required target', () => {
    const target = text('t', 50);
    target.requiredLevel = 'ApplicationRequired';
    expect(err(convertValue(null, src, target))).toBe(
      'target column is required but the source value is null',
    );
  });

  it('trims padding before deciding whether text fits', () => {
    expect(ok(convertValue('  hello  ', src, text('t', 5)))).toBe('hello');
  });

  it('reports truncation instead of silently cutting the value', () => {
    const e = err(convertValue('x'.repeat(60), src, text('t', 50)));
    expect(e).toBe('value is 60 characters, target allows 50');
  });

  it('accepts any length for a MAX target', () => {
    expect(ok(convertValue('x'.repeat(9000), src, text('t', null)))).toHaveLength(9000);
  });

  it('parses numbers from text and reports the ones that are not numeric', () => {
    const int = sqlAttr('n', 'int', 'Integer', { minValue: -2147483648, maxValue: 2147483647 });
    expect(ok(convertValue('42', src, int))).toBe(42);
    expect(err(convertValue('twelve', src, int))).toContain('not a numeric value');
    expect(err(convertValue('', src, int))).toContain('not a numeric value');
  });

  it('refuses a fractional value for an integer column', () => {
    const int = sqlAttr('n', 'int', 'Integer');
    expect(err(convertValue(1.5, src, int))).toMatch(/fractional part/);
  });

  it('detects integer overflow against the target range', () => {
    const small = sqlAttr('n', 'smallint', 'Integer', { minValue: -32768, maxValue: 32767 });
    expect(ok(convertValue(32767, src, small))).toBe(32767);
    expect(err(convertValue(40000, src, small))).toMatch(/outside the range/);
    expect(err(convertValue(-40000, src, small))).toMatch(/outside the range/);
  });

  it('rounds decimals only when no non-zero digit is lost', () => {
    const money = dec('m', 18, 2);
    expect(ok(convertValue(10.5, src, money))).toBe(10.5);
    expect(ok(convertValue('10.500', src, money))).toBe(10.5);
    expect(err(convertValue(10.005, src, money))).toMatch(/more than 2 decimal places/);
  });

  it('keeps full precision for a float target', () => {
    expect(ok(convertValue(1.234567, src, sqlAttr('f', 'float', 'Double')))).toBe(1.234567);
  });

  it('reads booleans from 0/1 and the usual words', () => {
    const bit = sqlAttr('b', 'bit', 'Boolean');
    expect(ok(convertValue(1, src, bit))).toBe(true);
    expect(ok(convertValue(0, src, bit))).toBe(false);
    expect(ok(convertValue('true', src, bit))).toBe(true);
    expect(ok(convertValue('False', src, bit))).toBe(false);
    expect(ok(convertValue('Y', src, bit))).toBe(true);
    expect(ok(convertValue('n', src, bit))).toBe(false);
    expect(err(convertValue(2, src, bit))).toMatch(/not a boolean/);
    expect(err(convertValue('maybe', src, bit))).toMatch(/not a boolean/);
  });

  it('parses dates and rejects invalid ones', () => {
    const dt = sqlAttr('d', 'datetime2', 'DateTime', { dateTimeBehavior: 'TimeZoneIndependent' });
    expect(ok(convertValue('2024-03-05T08:30:00Z', src, dt))).toBe('2024-03-05T08:30:00.000Z');
    expect(err(convertValue('not-a-date', src, dt))).toMatch(/not a valid date/);
    expect(err(convertValue('2024-02-30', src, dt))).toMatch(/not a valid date/);
  });

  it('drops the time component for a DateOnly target', () => {
    const d = sqlAttr('d', 'date', 'DateTime', { dateTimeBehavior: 'DateOnly' });
    expect(ok(convertValue('2024-03-05T08:30:00Z', src, d))).toBe('2024-03-05');
  });

  it('normalizes GUIDs to lowercase and rejects malformed ones', () => {
    const g = sqlAttr('id', 'uniqueidentifier', 'Uniqueidentifier');
    expect(ok(convertValue('{4C1E0F2A-9B8D-4E7A-8C3F-1A2B3C4D5E6F}', src, g))).toBe(
      '4c1e0f2a-9b8d-4e7a-8c3f-1a2b3c4d5e6f',
    );
    expect(err(convertValue('not-a-guid', src, g))).toMatch(/not a valid GUID/);
  });

  it('builds a lookup value when the target references exactly one table', () => {
    const l = attr('parentid', 'Lookup', { targets: ['dbo.Customer'] });
    expect(ok(convertValue('4C1E0F2A-9B8D-4E7A-8C3F-1A2B3C4D5E6F', src, l))).toEqual({
      id: '4c1e0f2a-9b8d-4e7a-8c3f-1a2b3c4d5e6f',
      logicalName: 'dbo.Customer',
    });
    const poly = attr('customerid', 'Lookup', { targets: ['account', 'contact'] });
    expect(err(convertValue('4C1E0F2A-9B8D-4E7A-8C3F-1A2B3C4D5E6F', src, poly))).toMatch(
      /cannot be inferred/,
    );
  });

  it('refuses a free-text value for a choice target', () => {
    expect(err(convertValue('Gold', src, attr('c', 'Picklist')))).toMatch(/choice mapping is required/);
    expect(ok(convertValue('3', src, attr('c', 'Picklist')))).toBe(3);
  });

  it('refuses to convert an unmovable source column', () => {
    const blob = sqlAttr('photo', 'varbinary', 'Other');
    expect(err(convertValue('AAEC', blob, text('t', 50)))).toMatch(/cannot be migrated/);
  });

  it('never throws on an unexpected shape', () => {
    const other = sqlAttr('t', 'time', 'Other');
    expect(convertValue('08:30:00', src, other)).toEqual({ ok: true, value: '08:30:00' });
    expect(convertValue({ id: 'x', logicalName: 'y' }, src, text('t', 50)).ok).toBe(false);
  });
});
