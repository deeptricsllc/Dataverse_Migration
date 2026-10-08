import type { DifferenceType } from './domain';

/**
 * What a difference means, and what to do about it.
 *
 * One table, derived from the category the engine recorded. Not parsed from a message: the engine
 * already decided what kind of difference this is, and re-deriving that from the text it wrote would
 * mean two sources of truth, the second of which breaks whenever somebody improves the wording.
 *
 * It exists because a report that lists differences is not the same as a report somebody can act on.
 * A row reading `telephone1 | 0412 345 678 | (blank)` tells a reader what the comparison saw. It does
 * not tell them which rule produced the finding, what it costs them, or where to go next — and those
 * three are the whole reason they opened the report.
 *
 * Both the screen and the CSV read this, so the next action a reader is given on screen is the one in
 * the evidence they attach to a change record.
 */
export interface FindingExplanation {
  /** The finding, as a short noun phrase. A heading, not a sentence. */
  label: string;
  /** The comparison rule that produced it. */
  rule: string;
  /** What it means for the migration. The `Why it matters` line. */
  consequence: string;
  /** What to do. One instruction. */
  nextAction: string;
  /**
   * What the left-hand value is, for this kind of finding.
   *
   * Not always "source value". On a value comparison it is the value the run was supposed to write,
   * which is the source value after the transformation — labelling that "Source" would invite a
   * reader to compare it against the source system by hand and find a difference that is correct.
   */
  expectedLabel: string;
  actualLabel: string;
  /**
   * Whether this finding is about a value at all.
   *
   * A missing record has no pair of values to show, so a detail panel that shows the pair anyway
   * prints two rows reading `no value` and asks the reader to work out that they mean nothing here.
   * The record identity is what matters for those, and the category says the rest.
   */
  hasValues: boolean;
}

const EXPECTED_VALUE = 'Expected value';
const TARGET_VALUE = 'Value in target';

/**
 * The table.
 *
 * Every entry says what the comparison did, not what the reader should feel about it. `VALUE_LOST`
 * and `VALUE_TRUNCATED` are kept apart from `VALUE_MISMATCH` because they have different fixes: a
 * value that is gone points at the source or at a required column, a value cut short points at a
 * target column too narrow to hold the data, and truncation is the dangerous one because the record
 * still looks right.
 */
const EXPLANATIONS: Record<DifferenceType, FindingExplanation> = {
  MISSING_IN_TARGET: {
    label: 'Missing record',
    /*
     * The narrower meaning, now that a record the run reported as failed has its own category.
     * This one the run said it had dealt with, and it is not there — which nobody has explained yet,
     * and which the run's failure list will not mention.
     */
    rule: 'The run recorded a target record for this source record. No record with that identity is in the target now.',
    consequence:
      'The record is not in the target, and the run did not report a failure for it. Something removed it after the run.',
    nextAction: 'Check whether the record was deleted in the target, then migrate it again.',
    expectedLabel: 'Source record',
    actualLabel: 'Target record',
    hasValues: false,
  },
  RECORD_FAILED_IN_RUN: {
    label: 'Record failed in the run',
    rule: 'The run reported this record as failed. The comparison confirms no target record carries its identity.',
    consequence: 'The record is not in the target. The run already recorded why it could not be written.',
    nextAction: 'Open the run, read the failure for this record, then retry the outstanding records.',
    expectedLabel: 'Source record',
    actualLabel: 'Target record',
    hasValues: false,
  },
  VALUE_MISMATCH: {
    label: 'Field mismatch',
    rule: 'The target value is compared against the source value after the transformations the run applied.',
    consequence: 'The target holds a different value from the one the run was supposed to write.',
    nextAction: 'Review the mapping and the transformations for this field.',
    expectedLabel: EXPECTED_VALUE,
    actualLabel: TARGET_VALUE,
    hasValues: true,
  },
  VALUE_LOST: {
    label: 'Value not written',
    rule: 'The source had a value after the transformations. The target column holds no value.',
    consequence:
      'Data that exists in the source is not in the target. A report that reads this column is wrong.',
    nextAction: 'Check that the field is in the mapping and that the target column accepts the value.',
    expectedLabel: EXPECTED_VALUE,
    actualLabel: TARGET_VALUE,
    hasValues: true,
  },
  VALUE_TRUNCATED: {
    label: 'Value cut short',
    rule: 'The target holds the start of the expected value, at the exact length the column declares.',
    consequence: 'The record looks correct and part of the value is gone. A search on the full value fails.',
    nextAction: 'Increase the length of the target column, then migrate the records again.',
    expectedLabel: EXPECTED_VALUE,
    actualLabel: TARGET_VALUE,
    hasValues: true,
  },
  LOOKUP_MISMATCH: {
    label: 'Relationship mismatch',
    rule: 'The source reference is resolved to the target record the run should have pointed at.',
    consequence: 'The record is in the target with the wrong parent. Reports by parent give wrong totals.',
    nextAction: 'Review the mapping for the referenced table, then migrate the records again.',
    expectedLabel: 'Expected reference',
    actualLabel: 'Reference in target',
    hasValues: true,
  },
  BROKEN_REFERENCE: {
    label: 'Broken reference',
    rule: 'Every reference on a compared target record must point at a record that exists in the target.',
    consequence: 'The reference points at nothing. The record cannot be opened through that relationship.',
    nextAction: 'Migrate the referenced table first, then migrate this table again.',
    // No left-hand value: the finding is that the reference in the target points at nothing.
    expectedLabel: 'Expected reference',
    actualLabel: 'Reference in target',
    hasValues: true,
  },
  PRE_EXISTING_DIFFERENCE: {
    label: 'Pre-existing difference',
    rule: 'The run skipped this record because the target already held a matching record.',
    consequence:
      'The target record differs from the source. The run did not write it and did not cause this.',
    nextAction: 'Decide whether the target record must be updated. This run did not change it.',
    expectedLabel: EXPECTED_VALUE,
    actualLabel: TARGET_VALUE,
    hasValues: true,
  },
};

/** The explanation for one difference. */
export const explainFinding = (type: DifferenceType): FindingExplanation =>
  EXPLANATIONS[type] ?? {
    label: type,
    rule: 'Not recorded.',
    consequence: 'Not recorded.',
    nextAction: 'Review the record in the target.',
    expectedLabel: EXPECTED_VALUE,
    actualLabel: TARGET_VALUE,
    hasValues: true,
  };

/** The short label for one difference, for a table cell or a filter. */
export const findingLabel = (type: DifferenceType): string => explainFinding(type).label;
