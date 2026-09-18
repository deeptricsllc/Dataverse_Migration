import { describe, expect, it } from 'vitest';
import { isLossyRule, type ChoiceMappingDto, type TransformationRule } from '../../shared/domain';
import type { FieldValue } from '../../shared/metadata';
import {
  applyRules,
  choiceMapRule,
  evaluate,
  rulesFromLegacy,
  transformField,
} from '../../server/src/services/transformation/engine';
import { attr } from './fixtures';

/**
 * The engine is the one place a source value becomes a target value, so these tests are the
 * contract that preview, preflight, migration and validation all rely on.
 */

const text = (max?: number) => attr('col', 'String', { maxLength: max ?? 200 });
const run = (value: FieldValue, ...rules: TransformationRule[]) => applyRules(value, rules);
const valueOf = (value: FieldValue, ...rules: TransformationRule[]) => {
  const result = run(value, ...rules);
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`);
  return result.value;
};

describe('string transformations', () => {
  it('trims', () => {
    expect(valueOf('  ACME  ', { kind: 'TRIM' })).toBe('ACME');
    expect(valueOf('  ACME  ', { kind: 'LEFT_TRIM' })).toBe('ACME  ');
    expect(valueOf('  ACME  ', { kind: 'RIGHT_TRIM' })).toBe('  ACME');
    // A non-string passes through untouched rather than being stringified behind the user's back.
    expect(valueOf(42, { kind: 'TRIM' })).toBe(42);
    expect(valueOf(null, { kind: 'TRIM' })).toBeNull();
  });

  it('changes case', () => {
    expect(valueOf(' JOHN@ABC.COM ', { kind: 'TRIM' }, { kind: 'LOWERCASE' })).toBe('john@abc.com');
    expect(valueOf('abc', { kind: 'UPPERCASE' })).toBe('ABC');
    expect(valueOf(null, { kind: 'LOWERCASE' })).toBeNull();
  });

  it('replaces literally, never as a pattern', () => {
    expect(valueOf('a.b.c', { kind: 'REPLACE', find: '.', replaceWith: '-' })).toBe('a-b-c');
    // A regular expression metacharacter is data, not syntax: nothing is compiled.
    expect(valueOf('a+b', { kind: 'REPLACE', find: '+', replaceWith: '-' })).toBe('a-b');
    expect(valueOf('(555) 123', { kind: 'REPLACE', find: '(', replaceWith: '' })).toBe('555) 123');
  });

  it('prefixes, suffixes and takes substrings', () => {
    expect(valueOf('123', { kind: 'PREFIX', value: 'ID-' })).toBe('ID-123');
    expect(valueOf('123', { kind: 'SUFFIX', value: '-X' })).toBe('123-X');
    expect(valueOf(null, { kind: 'PREFIX', value: 'ID-' })).toBeNull();
    expect(valueOf('ABCDEF', { kind: 'SUBSTRING', start: 1, length: 3 })).toBe('BCD');
    expect(valueOf('ABCDEF', { kind: 'SUBSTRING', start: 2 })).toBe('CDEF');
  });

  it('truncates only when asked, and reports the loss', () => {
    const result = run('abcdefghij', { kind: 'TRUNCATE', length: 4 });
    expect(result).toMatchObject({ ok: true, value: 'abcd' });
    if (!result.ok) throw new Error('unreachable');
    expect(result.warning?.code).toBe('LOSSY_TRANSFORMATION');
    // A value that already fits is not a loss.
    expect(run('abc', { kind: 'TRUNCATE', length: 10 })).toMatchObject({ ok: true, warning: undefined });
  });
});

describe('null and blank handling', () => {
  it('is always explicit', () => {
    expect(valueOf('', { kind: 'EMPTY_TO_NULL' })).toBeNull();
    expect(valueOf('   ', { kind: 'EMPTY_TO_NULL' })).toBeNull();
    expect(valueOf('kept', { kind: 'EMPTY_TO_NULL' })).toBe('kept');
    expect(valueOf(null, { kind: 'NULL_TO_EMPTY' })).toBe('');
    expect(valueOf(null, { kind: 'DEFAULT_IF_NULL', value: 'unknown' })).toBe('unknown');
    // DEFAULT_IF_NULL leaves a blank string alone; DEFAULT_IF_BLANK does not.
    expect(valueOf('', { kind: 'DEFAULT_IF_NULL', value: 'unknown' })).toBe('');
    expect(valueOf('  ', { kind: 'DEFAULT_IF_BLANK', value: 'unknown' })).toBe('unknown');
    expect(valueOf('x', { kind: 'CONSTANT', value: 'always' })).toBe('always');
  });

  it('blocks a missing value when the mapping requires one', () => {
    expect(run(null, { kind: 'BLOCK_IF_NULL' })).toMatchObject({
      ok: false,
      code: 'REQUIRED_VALUE_MISSING',
    });
    expect(run('present', { kind: 'BLOCK_IF_NULL' })).toMatchObject({ ok: true });
  });
});

describe('type conversions', () => {
  it('converts numbers and reports what is not one', () => {
    expect(valueOf('42', { kind: 'TO_INTEGER' })).toBe(42);
    expect(valueOf(' 42 ', { kind: 'TO_INTEGER' })).toBe(42);
    expect(valueOf(null, { kind: 'TO_INTEGER' })).toBeNull();
    expect(run('abc', { kind: 'TO_INTEGER' })).toMatchObject({ ok: false, code: 'INVALID_NUMBER' });
    // Dropping decimals is a loss and is reported as one.
    const truncated = run('42.7', { kind: 'TO_INTEGER' });
    expect(truncated).toMatchObject({ ok: true, value: 42 });
    if (!truncated.ok) throw new Error('unreachable');
    expect(truncated.warning?.code).toBe('LOSSY_TRANSFORMATION');
  });

  it('converts decimals and rounds only to a configured scale', () => {
    expect(valueOf('42.567', { kind: 'TO_DECIMAL' })).toBeCloseTo(42.567);
    expect(valueOf('42.567', { kind: 'TO_DECIMAL', scale: 2 })).toBe(42.57);
    expect(run('n/a', { kind: 'TO_DECIMAL' })).toMatchObject({ ok: false, code: 'INVALID_NUMBER' });
  });

  it('converts booleans only from values it can justify', () => {
    for (const truthy of ['Y', 'yes', 'TRUE', '1']) {
      expect(valueOf(truthy, { kind: 'TO_BOOLEAN' }), truthy).toBe(true);
    }
    for (const falsy of ['N', 'no', 'FALSE', '0']) {
      expect(valueOf(falsy, { kind: 'TO_BOOLEAN' }), falsy).toBe(false);
    }
    // "ACTIVE" does not universally mean true, so it has to be configured.
    expect(run('ACTIVE', { kind: 'TO_BOOLEAN' })).toMatchObject({ ok: false, code: 'VALUE_MAP_MISSING' });
    expect(
      valueOf('ACTIVE', {
        kind: 'TO_BOOLEAN',
        map: [
          { from: 'ACTIVE', to: true },
          { from: 'INACTIVE', to: false },
        ],
      }),
    ).toBe(true);
    expect(valueOf(null, { kind: 'TO_BOOLEAN' })).toBeNull();
  });

  it('converts GUIDs and refuses anything else', () => {
    expect(valueOf('A4F3C2D1-1111-4222-8333-444455556666', { kind: 'TO_GUID' })).toBe(
      'a4f3c2d1-1111-4222-8333-444455556666',
    );
    // A legacy database often stores a GUID without dashes.
    expect(valueOf('a4f3c2d1111142228333444455556666', { kind: 'TO_GUID' })).toBe(
      'a4f3c2d1-1111-4222-8333-444455556666',
    );
    expect(run('not-a-guid', { kind: 'TO_GUID' })).toMatchObject({ ok: false, code: 'INVALID_GUID' });
  });
});

describe('date conversion', () => {
  it('accepts an unambiguous date', () => {
    expect(valueOf('2020-01-15', { kind: 'TO_DATETIME' })).toBe('2020-01-15T00:00:00.000Z');
    expect(valueOf('2020-01-15T10:30:00Z', { kind: 'TO_DATE' })).toBe('2020-01-15');
  });

  it('refuses an ambiguous date rather than guessing the month', () => {
    const result = run('01/02/2020', { kind: 'TO_DATETIME' });
    expect(result).toMatchObject({ ok: false, code: 'INVALID_DATE' });
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('ambiguous');
  });

  it('uses the configured format when one is given', () => {
    expect(valueOf('01/02/2020', { kind: 'TO_DATETIME', inputFormat: 'MM/DD/YYYY' })).toBe(
      '2020-01-02T00:00:00.000Z',
    );
    expect(valueOf('01/02/2020', { kind: 'TO_DATETIME', inputFormat: 'DD/MM/YYYY' })).toBe(
      '2020-02-01T00:00:00.000Z',
    );
    expect(run('15/15/2020', { kind: 'TO_DATETIME', inputFormat: 'MM/DD/YYYY' })).toMatchObject({
      ok: false,
      code: 'INVALID_DATE',
    });
  });

  it('refuses a date that does not exist', () => {
    // Date.parse would roll this forward to 1 March and silently move the record.
    expect(run('2024-02-30', { kind: 'TO_DATETIME' })).toMatchObject({ ok: false, code: 'INVALID_DATE' });
  });

  it('reports dropping the time of day as a loss', () => {
    const result = run('2020-01-15T10:30:00Z', { kind: 'TO_DATE' });
    if (!result.ok) throw new Error('unreachable');
    expect(result.warning?.message).toContain('time of day dropped');
  });
});

describe('value mapping', () => {
  const rule: TransformationRule = {
    kind: 'VALUE_MAP',
    map: [
      { from: 'A', to: 'Active' },
      { from: 'ACTIVE', to: 'Active' },
      { from: 'Active', to: 'Active' },
      { from: 'D', to: 'Disabled' },
    ],
  };

  it('maps many source values onto one target value, ignoring case and spacing', () => {
    for (const source of ['A', 'ACTIVE', 'active', ' Active ']) {
      expect(valueOf(source, rule), source).toBe('Active');
    }
    expect(valueOf('D', rule)).toBe('Disabled');
  });

  it('blocks an unknown value by default', () => {
    expect(run('X', rule)).toMatchObject({ ok: false, code: 'VALUE_MAP_MISSING' });
  });

  it('honours an explicitly configured policy for unknown values', () => {
    expect(valueOf('X', { ...rule, onUnmapped: 'IGNORE' })).toBeNull();
    expect(valueOf('X', { ...rule, onUnmapped: 'DEFAULT', defaultValue: 'Unknown' })).toBe('Unknown');
  });

  it('treats an excluded choice value as a decision, not a gap', () => {
    const choiceMap: ChoiceMappingDto = {
      entries: [
        { sourceValue: 'MFG', targetValue: 1, targetLabel: 'Manufacturing', status: 'CONFIRMED' },
        { sourceValue: 'Aerospace', targetValue: null, targetLabel: null, status: 'IGNORED' },
        { sourceValue: 'Retail', targetValue: null, targetLabel: null, status: 'UNMAPPED' },
      ],
      defaultTargetValue: null,
    };
    const asRule = choiceMapRule(choiceMap);
    expect(valueOf('MFG', asRule)).toBe(1);
    // Excluded: becomes empty.
    expect(valueOf('Aerospace', asRule)).toBeNull();
    // Nobody decided: blocks.
    expect(run('Retail', asRule)).toMatchObject({ ok: false, code: 'VALUE_MAP_MISSING' });
  });
});

describe('composition', () => {
  const context = {
    record: {
      values: { FirstName: 'John', MiddleName: null, LastName: 'Smith' } as Record<string, FieldValue>,
    },
  };

  it('concatenates source fields with a separator', () => {
    const result = applyRules(
      null,
      [
        {
          kind: 'CONCAT',
          separator: ' ',
          parts: [{ field: 'FirstName' }, { field: 'MiddleName' }, { field: 'LastName' }],
        },
      ],
      context,
    );
    // The null middle name is skipped, so there is no double space.
    expect(result).toMatchObject({ ok: true, value: 'John Smith' });
  });

  it('keeps empty parts when asked to', () => {
    const result = applyRules(
      null,
      [
        {
          kind: 'CONCAT',
          separator: '|',
          skipEmptyParts: false,
          parts: [{ field: 'FirstName' }, { field: 'MiddleName' }, { field: 'LastName' }],
        },
      ],
      context,
    );
    expect(result).toMatchObject({ ok: true, value: 'John||Smith' });
  });

  it('mixes literals with fields', () => {
    const result = applyRules(
      null,
      [{ kind: 'CONCAT', parts: [{ literal: 'ACC-' }, { field: 'LastName' }] }],
      context,
    );
    expect(result).toMatchObject({ ok: true, value: 'ACC-Smith' });
  });
});

describe('conditional rules', () => {
  const context = { record: { values: { Country: 'US', State: null } as Record<string, FieldValue> } };

  it('applies a value only when the condition holds', () => {
    const rule: TransformationRule = {
      kind: 'IF_THEN',
      condition: { field: 'Country', operator: 'EQUALS', value: 'US' },
      action: 'SET_VALUE',
      value: 'Unknown',
    };
    expect(applyRules(null, [rule], context)).toMatchObject({ ok: true, value: 'Unknown' });
    const other = { record: { values: { Country: 'CA' } as Record<string, FieldValue> } };
    expect(applyRules('keep', [rule], other)).toMatchObject({ ok: true, value: 'keep' });
  });

  it('supports the closed operator list', () => {
    expect(evaluate({ operator: 'IS_NULL' }, null, {})).toBe(true);
    expect(evaluate({ operator: 'IS_NOT_NULL' }, 'x', {})).toBe(true);
    expect(evaluate({ operator: 'IS_BLANK' }, '   ', {})).toBe(true);
    expect(evaluate({ operator: 'CONTAINS', value: 'cme' }, 'Acme', {})).toBe(true);
    expect(evaluate({ operator: 'STARTS_WITH', value: 'ac' }, 'Acme', {})).toBe(true);
    expect(evaluate({ operator: 'GREATER_THAN', value: 5 }, 7, {})).toBe(true);
    expect(evaluate({ operator: 'LESS_THAN', value: 5 }, 7, {})).toBe(false);
    expect(evaluate({ operator: 'NOT_EQUALS', value: 'a' }, 'b', {})).toBe(true);
  });

  it('can run a nested pipeline when the condition holds', () => {
    const rule: TransformationRule = {
      kind: 'IF_THEN',
      condition: { operator: 'IS_NOT_NULL' },
      action: 'APPLY',
      then: [{ kind: 'TRIM' }, { kind: 'UPPERCASE' }],
    };
    expect(applyRules('  acme ', [rule], {})).toMatchObject({ ok: true, value: 'ACME' });
  });
});

describe('ordering', () => {
  it('applies rules in the configured order', () => {
    // TRIM then TRUNCATE(4) keeps "abcd"; the reverse keeps "  ab" -> "ab".
    expect(valueOf('  abcdef', { kind: 'TRIM' }, { kind: 'TRUNCATE', length: 4 })).toBe('abcd');
    expect(valueOf('  abcdef', { kind: 'TRUNCATE', length: 4 }, { kind: 'TRIM' })).toBe('ab');
  });

  it('stops at the first failure and reports it', () => {
    const result = run('not-a-number', { kind: 'TO_INTEGER' }, { kind: 'CONSTANT', value: 'never reached' });
    expect(result).toMatchObject({ ok: false, code: 'INVALID_NUMBER' });
  });
});

describe('the whole field path', () => {
  it('reports what it did, including losses', () => {
    const result = transformField({
      value: '  ACME Corporation  ',
      source: text(500),
      target: text(10),
      rules: [{ kind: 'TRIM' }, { kind: 'TRUNCATE', length: 10 }],
    });
    expect(result.ok).toBe(true);
    expect(result.value).toBe('ACME Corpo');
    expect(result.lossy).toBe(true);
    expect(result.applied.map((a) => a.kind)).toEqual(['TRIM', 'TRUNCATE']);
    expect(result.applied[0]).toMatchObject({ before: '  ACME Corporation  ', after: 'ACME Corporation' });
  });

  it('blocks a value too long for the target instead of truncating it silently', () => {
    const result = transformField({
      value: 'x'.repeat(200),
      source: text(500),
      target: text(160),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'STRING_TOO_LONG' });
    expect(result.error!.message).toContain('200 characters, target allows 160');
  });

  it('blocks an empty value for a required target column', () => {
    const required = attr('name', 'String', { maxLength: 160, requiredLevel: 'ApplicationRequired' });
    const result = transformField({
      value: '   ',
      source: text(500),
      target: required,
      rules: [{ kind: 'EMPTY_TO_NULL' }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'REQUIRED_VALUE_MISSING' });
  });

  it('runs the pipeline before the choice map', () => {
    const result = transformField({
      value: '  active  ',
      source: text(50),
      target: attr('statuscode', 'Picklist', {
        options: [
          { value: 1, label: 'Active' },
          { value: 2, label: 'Inactive' },
        ],
      }),
      rules: [{ kind: 'TRIM' }, { kind: 'UPPERCASE' }],
      choiceMap: {
        entries: [{ sourceValue: 'ACTIVE', targetValue: 1, targetLabel: 'Active', status: 'CONFIRMED' }],
        defaultTargetValue: null,
      },
    });
    expect(result).toMatchObject({ ok: true, value: 1 });
  });

  it('turns a legacy single-step transformation into a pipeline', () => {
    expect(rulesFromLegacy({ kind: 'TRIM' })).toEqual([{ kind: 'TRIM', value: null }]);
    expect(rulesFromLegacy({ kind: 'DIRECT' })).toEqual([]);
    expect(rulesFromLegacy(null)).toEqual([]);
    const result = transformField({
      value: '  ACME  ',
      source: text(50),
      target: text(50),
      legacyTransform: { kind: 'TRIM' },
    });
    expect(result.value).toBe('ACME');
  });

  it('is deterministic: the same input always produces the same output', () => {
    const input = {
      value: ' Mixed Case ',
      source: text(50),
      target: text(50),
      rules: [{ kind: 'TRIM' as const }, { kind: 'LOWERCASE' as const }],
    };
    const a = transformField(input);
    const b = transformField(input);
    expect(a.value).toBe(b.value);
    expect(a.applied).toEqual(b.applied);
  });
});

describe('lossy classification', () => {
  it('treats rounding as lossy only when a scale is configured', () => {
    // Without a scale TO_DECIMAL is a plain conversion; with one it discards digits.
    expect(isLossyRule({ kind: 'TO_DECIMAL' })).toBe(false);
    expect(isLossyRule({ kind: 'TO_DECIMAL', scale: 2 })).toBe(true);
  });

  it('classifies the rules that discard information', () => {
    for (const kind of ['TRUNCATE', 'SUBSTRING', 'TO_DATE', 'TO_INTEGER'] as const) {
      expect(isLossyRule({ kind }), kind).toBe(true);
    }
    for (const kind of ['TRIM', 'LOWERCASE', 'VALUE_MAP', 'CONCAT'] as const) {
      expect(isLossyRule({ kind }), kind).toBe(false);
    }
  });
});
