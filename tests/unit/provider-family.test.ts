import { describe, expect, it } from 'vitest';
import { crossFamily, familyOf } from '../../shared/metadata';
import { fieldVerdict, needsChoiceMapping } from '../../server/src/services/field-verdict';
import { validateManualMapping } from '../../server/src/services/mapping';
import { transformField } from '../../server/src/services/transformation/engine';
import { attr } from './fixtures';

/**
 * Which kind of system a column came from.
 *
 * This used to be inferred from whether the optional `sql` property happened to be populated, which
 * was true enough while there were exactly two kinds of provider. A third kind — a spreadsheet, a
 * list, anything whose columns are inferred from data — would have been read as Dataverse, and a
 * value moving from it into a real system would have skipped type conversion entirely. That is a
 * silent data-correctness failure rather than an error, which is why it is pinned here.
 */

const sqlColumn = (over: Parameters<typeof attr>[2] = {}) =>
  attr('col', 'String', {
    maxLength: 100,
    sql: {
      dataType: 'varchar',
      maxLength: 100,
      precision: null,
      scale: null,
      isNullable: true,
      isIdentity: false,
      isComputed: false,
      isRowVersion: false,
      defaultDefinition: null,
    },
    family: 'SQL',
    ...over,
  });

const dataverseColumn = (over: Parameters<typeof attr>[2] = {}) =>
  attr('col', 'String', { maxLength: 100, ...over });

const tabularColumn = (over: Parameters<typeof attr>[2] = {}) =>
  attr('col', 'String', { maxLength: 100, family: 'TABULAR', ...over });

describe('which family a column belongs to', () => {
  it('takes the family a provider states', () => {
    expect(familyOf(tabularColumn())).toBe('TABULAR');
    expect(familyOf(sqlColumn())).toBe('SQL');
    expect(familyOf(dataverseColumn())).toBe('DATAVERSE');
  });

  it('falls back only for metadata that predates the field', () => {
    // A cached SQL column with no stated family still has `sql`, so it is still SQL.
    const cachedSql = sqlColumn();
    delete cachedSql.family;
    expect(familyOf(cachedSql)).toBe('SQL');
    // And a cached column with neither was Dataverse, which is what it used to mean.
    expect(familyOf(dataverseColumn())).toBe('DATAVERSE');
  });

  it('treats a tabular column as foreign to both real systems', () => {
    // The case the old inference got wrong: a spreadsheet column has no `sql`, so it read as
    // Dataverse, and a Dataverse-to-Dataverse mapping converts nothing.
    expect(crossFamily(tabularColumn(), dataverseColumn())).toBe(true);
    expect(crossFamily(tabularColumn(), sqlColumn())).toBe(true);
    expect(crossFamily(sqlColumn(), dataverseColumn())).toBe(true);
    expect(crossFamily(dataverseColumn(), dataverseColumn())).toBe(false);
    expect(crossFamily(sqlColumn(), sqlColumn())).toBe(false);
  });
});

describe('what the family decides', () => {
  it('routes a tabular-to-Dataverse mapping through the cross-provider rules', () => {
    // A 300-character spreadsheet column into a 100-character Dataverse column is a real narrowing
    // and has to be reported as lossy rather than waved through.
    const source = tabularColumn({ maxLength: 300 });
    const target = dataverseColumn({ maxLength: 100 });
    expect(fieldVerdict(source, target)).not.toBe('COMPATIBLE');
    expect(validateManualMapping(source, target)).toBeNull();
  });

  it('converts a value arriving from a spreadsheet instead of copying it', () => {
    // Everything in a delimited file is text. Moving it into a whole-number column has to parse it;
    // treating the mapping as same-provider would hand the target the string.
    const result = transformField({
      value: '42',
      source: tabularColumn({ type: 'String' }),
      target: attr('employees', 'Integer'),
      rules: [],
    });
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
  });

  it('refuses a value a spreadsheet cannot supply, rather than writing nonsense', () => {
    const result = transformField({
      value: 'not a number',
      source: tabularColumn({ type: 'String' }),
      target: attr('employees', 'Integer'),
      rules: [],
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBeTruthy();
  });

  it('asks for a value map when a choice is fed from outside Dataverse', () => {
    const choice = attr('statuscode', 'Picklist', {
      options: [
        { value: 1, label: 'Active' },
        { value: 2, label: 'Inactive' },
      ],
    });
    // A spreadsheet holds "Active", not the option set's numeric code, so the mapping is incomplete
    // until somebody says which code each value means.
    expect(needsChoiceMapping(tabularColumn(), choice)).toBe(true);
    expect(needsChoiceMapping(sqlColumn(), choice)).toBe(true);
    // Dataverse to the same Dataverse choice is a straight copy.
    expect(needsChoiceMapping(choice, choice)).toBe(false);
  });
});
