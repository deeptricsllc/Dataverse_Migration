import { describe, expect, it } from 'vitest';
import type { TransformationRule } from '../../shared/domain';
import type { FieldValue } from '../../shared/metadata';
import { lostSteps, transformField } from '../../server/src/services/transformation/engine';
import { attr } from './fixtures';

/**
 * How many records a lossy transformation actually affects.
 *
 * The number shown on the acknowledgement screen has to mean "this many records will come out of
 * the migration missing something", not "this many records the rule ran on". These tests pin that
 * difference down, because overstating it trains people to click through the warning.
 */

/**
 * Counts exactly the way the preflight and the sampled scan count: run the real engine over each
 * value and ask which steps reported discarding something.
 */
function affected(values: FieldValue[], rules: TransformationRule[], target = attr('col', 'String')) {
  let n = 0;
  for (const value of values) {
    const result = transformField({
      value,
      source: attr('col', 'String', { maxLength: 4000 }),
      target,
      rules,
    });
    if (lostSteps(result.applied).length > 0) n++;
  }
  return n;
}

describe('affected record counts', () => {
  it('counts only the records TRUNCATE actually shortens', () => {
    // 100 names, 7 of which are longer than the target column allows.
    const names = Array.from({ length: 100 }, (_, i) =>
      i < 7 ? 'x'.repeat(161 + i) : `Contoso Holdings ${i}`,
    );
    const target = attr('name', 'String', { maxLength: 160 });
    const rules: TransformationRule[] = [{ kind: 'TRUNCATE', length: 160 }];

    expect(affected(names, rules, target)).toBe(7);
    // The rule ran on all 100. Reporting 100 would be the bug this number exists to avoid.
    expect(names).toHaveLength(100);
    // A value exactly at the limit keeps every character, so nothing was lost.
    expect(affected(['y'.repeat(160)], rules, target)).toBe(0);
  });

  it('counts only the dates TO_DATE strips a time from', () => {
    // 40 timestamps, 12 of which carry a time of day.
    const dates = Array.from({ length: 40 }, (_, i) =>
      i < 12 ? `2024-03-0${(i % 9) + 1}T14:${String(10 + i).padStart(2, '0')}:00Z` : `2024-03-1${i % 10}`,
    );
    const target = attr('birthdate', 'DateTime', { dateTimeBehavior: 'DateOnly' });

    expect(affected(dates, [{ kind: 'TO_DATE' }], target)).toBe(12);
    // Midnight is a time of day that carries no information the date does not already hold.
    expect(affected(['2024-03-01T00:00:00Z'], [{ kind: 'TO_DATE' }], target)).toBe(0);
  });

  it('counts only the numbers TO_INTEGER drops digits from', () => {
    // 50 amounts, 8 of which have a fractional part.
    const amounts = Array.from({ length: 50 }, (_, i) => (i < 8 ? 100 + i + 0.5 : 100 + i));
    const target = attr('employees', 'Integer');

    expect(affected(amounts, [{ kind: 'TO_INTEGER' }], target)).toBe(8);
  });

  it('counts only the numbers a reduced scale actually rounds', () => {
    const amounts = [10.125, 10.5, 10.25, 10, 10.1];
    const target = attr('credit', 'Decimal', { precision: 2 });
    // Two of these five need a third decimal place they are not going to get.
    expect(affected(amounts, [{ kind: 'TO_DECIMAL', scale: 2 }], target)).toBe(1);
    expect(affected([1.999, 2.001], [{ kind: 'TO_DECIMAL', scale: 2 }], target)).toBe(2);
  });

  it('does not count a record whose value survives the transformation unchanged', () => {
    const target = attr('name', 'String', { maxLength: 160 });
    // Every one of these fits, is already a date, or is already whole.
    expect(affected(['Contoso', 'Fabrikam', ''], [{ kind: 'TRUNCATE', length: 160 }], target)).toBe(0);
    expect(affected([null, null], [{ kind: 'TRUNCATE', length: 5 }], target)).toBe(0);
    expect(affected([12, 7, 0], [{ kind: 'TO_INTEGER' }], attr('n', 'Integer'))).toBe(0);
    expect(affected(['2024-01-01'], [{ kind: 'TO_DATE' }], attr('d', 'DateTime'))).toBe(0);
    // A rule that changes the value without discarding anything is not loss either.
    expect(affected(['  acme  '], [{ kind: 'TRIM' }, { kind: 'UPPERCASE' }], target)).toBe(0);
  });

  it('describes what was lost without repeating the value', () => {
    const result = transformField({
      value: 'x'.repeat(200),
      source: attr('col', 'String', { maxLength: 4000 }),
      target: attr('name', 'String', { maxLength: 160 }),
      rules: [{ kind: 'TRUNCATE', length: 160 }],
    });
    const [step] = lostSteps(result.applied);
    // The reason is safe to show for a secured column: it carries no part of the value.
    expect(step.loss).toBe('200 characters truncated to 160');
    expect(step.loss).not.toContain('xxx');
  });
});
