import type { RecordOutcome } from './domain';

/**
 * What a migration run did with the records it reached a decision about.
 *
 * One definition of every figure, shared by the run, the validation report, the dashboard and the
 * exports. They used to each derive their own, and a record the run deliberately did not write was
 * being counted as a record the run had migrated — the report and the run said different things
 * about the same migration. For a product whose claim is "here is what actually happened", two
 * screens disagreeing is worse than either number being hard to compute.
 *
 * The outcomes are exhaustive and mutually exclusive: every record the run accounted for lands in
 * exactly one of them.
 */
export interface RecordAccounting {
  /** Did not exist in the target. This run inserted it. */
  created: number;
  /** Existed in the target and differed. This run changed it. */
  updated: number;
  /** Existed in the target and already matched the source. Nothing was sent. */
  unchanged: number;
  /**
   * Existed in the target and was deliberately left alone by the run's conflict rules, whether or
   * not it matched the source. Present in the target, but not this run's doing.
   */
  skipped: number;
  /** Processing was attempted and did not succeed. Not in the target because of this run. */
  failed: number;
  /**
   * The write may have happened and we cannot prove it either way.
   *
   * A timeout, a dropped connection, or a crash between writing to the target and recording it here.
   * Counted separately because it is neither a success nor a failure, and calling it either would be a
   * claim the evidence does not support. Not counted as written: we do not know that it was.
   */
  unresolved: number;
}

export const EMPTY_ACCOUNTING: RecordAccounting = {
  created: 0,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  failed: 0,
  unresolved: 0,
};

const FIELD_OF: Record<RecordOutcome, keyof RecordAccounting> = {
  CREATED: 'created',
  UPDATED: 'updated',
  UNCHANGED: 'unchanged',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  UNRESOLVED: 'unresolved',
};

/** Tallies record outcomes into the one shape everything else reads. */
export function countOutcomes(outcomes: Iterable<RecordOutcome>): RecordAccounting {
  const total = { ...EMPTY_ACCOUNTING };
  for (const outcome of outcomes) total[FIELD_OF[outcome]] += 1;
  return total;
}

/**
 * The same tally, built from counts the database already computed.
 *
 * `countOutcomes` needs every outcome in hand, which means loading every identity row to count it —
 * exactly what cannot work on the table where the count matters. A `GROUP BY outcome` returns five
 * numbers for ten million records, and this turns those five numbers into the same shape.
 *
 * An outcome this version does not recognise is counted nowhere rather than guessed at, so a future
 * outcome cannot quietly inflate one of these five.
 */
export function accountingFromCounts(counts: Iterable<{ outcome: string; n: number }>): RecordAccounting {
  const total = { ...EMPTY_ACCOUNTING };
  for (const { outcome, n } of counts) {
    const field = FIELD_OF[outcome as RecordOutcome];
    if (field) total[field] += Number(n) || 0;
  }
  return total;
}

export function addAccounting(a: RecordAccounting, b: RecordAccounting): RecordAccounting {
  return {
    created: a.created + b.created,
    updated: a.updated + b.updated,
    unchanged: a.unchanged + b.unchanged,
    skipped: a.skipped + b.skipped,
    failed: a.failed + b.failed,
    unresolved: a.unresolved + b.unresolved,
  };
}

export function sumAccounting(items: readonly RecordAccounting[]): RecordAccounting {
  return items.reduce(addAccounting, EMPTY_ACCOUNTING);
}

/**
 * The records this run put into the target: created plus updated, and nothing else.
 *
 * Unchanged and skipped records are in the target, but they were there first. Counting them here is
 * the product taking credit for work it did not do.
 */
export function writtenByRun(a: RecordAccounting): number {
  return a.created + a.updated;
}

/**
 * Every record the run reached a decision about, whatever that decision was.
 *
 * Including the ones whose outcome is unknown. They were processed — something was attempted and the
 * answer was lost — and leaving them out to keep `processed` equal to the other five would be hiding
 * them to keep the arithmetic tidy.
 */
export function accountedFor(a: RecordAccounting): number {
  return a.created + a.updated + a.unchanged + a.skipped + a.failed + a.unresolved;
}

/**
 * Records whose fate is not yet known, which is what stops a run being called complete.
 *
 * Zero is the only value a finished migration may have here.
 */
export function unresolvedCount(a: RecordAccounting): number {
  return a.unresolved;
}

/**
 * Records that should be in the target if the run did what it said: everything it wrote, plus
 * everything it found already there and left alone. Failed records are excluded, because the run
 * is telling you they did not make it.
 *
 * This — not `writtenByRun` — is the set validation verifies, which is why the two are separate
 * numbers rather than one number with two meanings.
 */
export function expectedInTarget(a: RecordAccounting): number {
  return a.created + a.updated + a.unchanged + a.skipped;
}

/**
 * Records that may be in the target without the platform being able to say so.
 *
 * The gap between what can be verified and what might be there. A report that does not show this number
 * is claiming more certainty than it has.
 */
export function possiblyInTarget(a: RecordAccounting): number {
  return a.unresolved;
}

/** Whether the run wrote nothing at all, which a report should say in words rather than show as 0. */
export function wroteNothing(a: RecordAccounting): boolean {
  return writtenByRun(a) === 0;
}

export type MetricKey =
  | 'processed'
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'skipped'
  | 'failed'
  | 'unresolved'
  | 'written'
  | 'expectedInTarget';

/**
 * The words the product uses for each figure, in one place.
 *
 * Shipped to the browser so a tooltip and a server-generated message cannot define the same term
 * differently. Changing a definition here changes it everywhere, which is the point.
 */
export const METRIC_DEFINITIONS: Record<MetricKey, { label: string; definition: string }> = {
  processed: {
    label: 'Processed',
    definition: 'Source records this run evaluated and reached a decision about.',
  },
  unresolved: {
    label: 'Outcome unknown',
    definition:
      'Records this run tried to write and cannot account for. The write may have been applied before the answer was lost, so they are counted neither as written nor as failed until the target is asked. Never retried blindly: repeating a write whose outcome is unknown is how one record becomes two.',
  },
  created: {
    label: 'Created',
    definition: 'Records that did not exist in the target. This run inserted them.',
  },
  updated: {
    label: 'Updated',
    definition: 'Records that existed in the target and differed. This run changed them.',
  },
  unchanged: {
    label: 'Unchanged',
    definition:
      'Records that existed in the target and already matched the source. Nothing was sent for them.',
  },
  skipped: {
    label: 'Skipped',
    definition:
      'Records that existed in the target and were left alone by the conflict rules. They are in the target, but this run did not write them.',
  },
  failed: {
    label: 'Failed',
    definition: 'Records this run tried to write and could not. They are not in the target.',
  },
  written: {
    label: 'Written by this run',
    definition:
      'Created plus updated: the records this run actually put into the target. Records that were already there do not count.',
  },
  expectedInTarget: {
    label: 'Expected in the target',
    definition:
      'Everything this run wrote, plus everything it found already there and left alone. This is the set validation checks.',
  },
};
