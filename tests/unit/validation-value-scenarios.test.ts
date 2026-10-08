import { describe, expect, it } from 'vitest';
import { compareValues, emptyEqualsNull, valuesEqual } from '../../server/src/services/values';
import type { AttributeMeta } from '../../shared/metadata';
import { attr } from './fixtures';

/**
 * The value-level scenarios, and the rule each one is traceable to.
 *
 * A comparison may only normalise a difference away for a reason a reader can find: a configured
 * rule, or a platform semantic recorded in `docs/SEMANTIC_EQUALITY.md`. These tests pin the ones the
 * report claims, so the rules shown beside a result cannot drift away from what the comparison does.
 * A rules panel that says one thing while the engine does another is worse than no rules panel.
 */

/** A SQL column needs every facet the metadata declares, and only two of them matter here. */
const withSql = (a: AttributeMeta, sql: Partial<NonNullable<AttributeMeta['sql']>>): AttributeMeta => ({
  ...a,
  sql: {
    dataType: 'varchar',
    maxLength: null,
    precision: null,
    scale: null,
    isNullable: true,
    isIdentity: false,
    isComputed: false,
    isRowVersion: false,
    defaultDefinition: null,
    ...sql,
  },
});

const dataverseText = attr('name', 'String', { maxLength: 100 });

/** The same column in a SQL target. `sql` present is what makes it a SQL column; see `familyOf`. */
const sqlText = withSql(attr('name', 'String', { maxLength: 100, family: 'SQL' }), {
  dataType: 'varchar',
  maxLength: 100,
});

const money = (precision: number) => attr('revenue', 'Money', { precision });

const timestamp = attr('createdon', 'DateTime');
const dateOnly = attr('birthdate', 'DateTime', { dateTimeBehavior: 'DateOnly' });

describe('11. null versus empty', () => {
  /**
   * They were always the same value, everywhere, which was wrong half the time.
   *
   * Dataverse stores an empty text value as no value, so a record saved with `''` reads back as null
   * and calling them different would report a mismatch the platform itself created. A SQL column
   * holds two distinct values, and calling them equal reported a text value the migration failed to
   * write as a match — a column that is empty in the target and full in the source, reading correct.
   */
  it('treats an empty value and no value as the same in Dataverse, because the platform does', () => {
    expect(emptyEqualsNull(dataverseText)).toBe(true);
    expect(valuesEqual(dataverseText, '', null)).toBe(true);
    expect(valuesEqual(dataverseText, null, '')).toBe(true);
  });

  it('treats them as two values in a SQL target, because the column holds two values', () => {
    expect(emptyEqualsNull(sqlText)).toBe(false);
    expect(valuesEqual(sqlText, '', null), 'an empty string is not the absence of a value').toBe(false);
    expect(valuesEqual(sqlText, null, ''), 'and it is not, the other way round either').toBe(false);
    // Two empty values are still equal, and two absent values are still equal.
    expect(valuesEqual(sqlText, '', '')).toBe(true);
    expect(valuesEqual(sqlText, null, null)).toBe(true);
  });

  it('does not report a difference where one side merely has padding', () => {
    // A fixed-width column pads. That is the normalisation the rules panel states, and it applies
    // within text — not across the boundary to no value at all.
    expect(valuesEqual(sqlText, 'abc', 'abc   ')).toBe(true);
    expect(valuesEqual(sqlText, 'abc', null)).toBe(false);
  });
});

describe('12. decimal precision and tolerance', () => {
  /**
   * The tolerance is the number of places the column declares, and the rules panel says so.
   *
   * A money column with two places cannot hold a tenth of a cent, so a difference smaller than one
   * cannot be a difference in the data. A difference it can hold is reported.
   */
  it('ignores a difference the column cannot hold, and reports one it can', () => {
    expect(valuesEqual(money(2), 10.001, 10.0), 'below the scale the column holds').toBe(true);
    expect(valuesEqual(money(2), 10.01, 10.0), 'a difference the column can hold').toBe(false);
  });

  it('compares the digits exactly when both sides give them as text', () => {
    // Drivers return wide decimals as strings precisely so the digits survive. Routing them through
    // a double would make these two equal.
    expect(valuesEqual(money(4), '12345678901234567890.1234', '12345678901234567890.1235')).toBe(false);
    expect(valuesEqual(money(4), '12345678901234567890.1234', '12345678901234567890.12340')).toBe(true);
  });
});

describe('13. date and time normalization', () => {
  /**
   * Compared to the second, in UTC. Engines keep different sub-second precision, so comparing finer
   * would report a difference on every timestamp between two systems.
   */
  it('compares the same instant written in two time zones as equal', () => {
    expect(valuesEqual(timestamp, '2024-06-01T10:00:00Z', '2024-06-01T03:00:00-07:00')).toBe(true);
  });

  it('ignores sub-second precision and reports a difference of one second', () => {
    expect(valuesEqual(timestamp, '2024-06-01T10:00:00.123Z', '2024-06-01T10:00:00.456Z')).toBe(true);
    expect(valuesEqual(timestamp, '2024-06-01T10:00:00Z', '2024-06-01T10:00:01Z')).toBe(false);
  });

  it('compares a date-only column as a date', () => {
    expect(valuesEqual(dateOnly, '2024-06-01T00:00:00Z', '2024-06-01T23:59:59-07:00')).toBe(true);
    expect(valuesEqual(dateOnly, '2024-06-01', '2024-06-02')).toBe(false);
  });
});

describe('a column with no honest answer is neither equal nor different', () => {
  /** The third verdict. Calling an unreadable value equal is a silent false pass. */
  it('reports a JSON document with a repeated key as not comparable', () => {
    const jsonColumn = withSql(attr('payload', 'String', { family: 'SQL' }), { dataType: 'jsonb' });
    const result = compareValues(jsonColumn, '{"a":1,"a":2}', '{"a":2}');
    expect(result.verdict).toBe('NOT_COMPARABLE');
    expect(result.reason, 'and the reason travels with the verdict').toBeTruthy();
  });
});
