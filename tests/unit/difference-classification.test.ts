import { describe, expect, it } from 'vitest';
import { classifyDifference } from '../../server/src/services/validation-service';
import { attr } from './fixtures';

/**
 * Which kind of difference a record has, because the three have different fixes.
 *
 * They used to be one. A value that arrived wrong is usually a mapping or a transformation; a value
 * that arrived empty is usually a required column the source could not fill; a value that arrived
 * shortened is a column too narrow for the data — and that last one is the dangerous case, because
 * the record still looks plausible afterwards.
 */
describe('classifying a value difference', () => {
  const text = (maxLength?: number) => attr('name', 'String', { maxLength: maxLength ?? null });

  it('calls a value that did not arrive lost, not merely different', () => {
    expect(classifyDifference(text(100), 'Acme Industries', null)).toBe('VALUE_LOST');
    expect(classifyDifference(text(100), 'Acme Industries', undefined)).toBe('VALUE_LOST');
    expect(classifyDifference(text(100), 'Acme Industries', '')).toBe('VALUE_LOST');
  });

  it('calls a value cut off at the column width truncated', () => {
    // 100 characters of source into a column that holds 60: the target is a prefix, and its length
    // is exactly the column's maximum. That combination is not a coincidence.
    const long = 'A'.repeat(100);
    expect(classifyDifference(text(60), long, 'A'.repeat(60))).toBe('VALUE_TRUNCATED');
  });

  it('does not call a shorter value truncated just because it starts the same way', () => {
    // "Acme" against "Acme Industries" is a mapping problem, not a column that is too narrow, and
    // sending somebody to widen a column would waste their afternoon.
    expect(classifyDifference(text(100), 'Acme Industries', 'Acme')).toBe('VALUE_MISMATCH');
    // Right length, wrong content: not a prefix, so not truncation.
    expect(classifyDifference(text(4), 'Acme Industries', 'Aero')).toBe('VALUE_MISMATCH');
    // No declared maximum means nothing to truncate against.
    expect(classifyDifference(text(undefined), 'Acme Industries', 'Acme')).toBe('VALUE_MISMATCH');
  });

  it('treats an unexpected value in an empty source as an ordinary mismatch', () => {
    // The target holding something the source does not is a difference worth reporting, but it is
    // not a loss: nothing was destroyed on the way in.
    expect(classifyDifference(text(100), null, 'Something')).toBe('VALUE_MISMATCH');
  });

  it('does not claim truncation for values that are not text', () => {
    const num = attr('revenue', 'Decimal', { maxLength: 10 });
    expect(classifyDifference(num, 123.456, 123.4)).toBe('VALUE_MISMATCH');
    expect(classifyDifference(num, 123.456, null)).toBe('VALUE_LOST');
  });
});
