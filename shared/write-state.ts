/**
 * Whether we know what happened to a record, which is a different question from what happened.
 *
 * The target's database and ours are two systems, written in that order, with no transaction across
 * them. So there is a window in which a record is in the customer's target and we have no row for it —
 * and a timeout is the same window without a crash, because a request that times out may have
 * committed. Before this existed the engine called that `FAILED` and re-processed it, which is how a
 * lost response became a duplicate record.
 *
 * `outcome` says what happened to the record. `writeState` says whether we are entitled to claim it.
 * They are separate columns because collapsing them is exactly the mistake that produced the bug: a
 * record can be "we tried to create it" and "we cannot prove it exists" at the same time, and one
 * field cannot hold both.
 */

export type WriteState =
  /**
   * We are about to write, or we were when the process stopped.
   *
   * Written before the target write and replaced after it. Found on resume, it means *this record may
   * or may not be in the target* — the intent proves we tried, and nothing about whether it committed.
   */
  | 'INTENDED'
  /** The target accepted the write and told us so. The only state that entitles us to claim it. */
  | 'CONFIRMED'
  /**
   * The write may have committed and we will never know from the response.
   *
   * A timeout, a dropped connection, a 5xx: the server may have applied it before the answer was lost.
   * Never retried, because retrying a create whose outcome is unknown is how one record becomes two.
   */
  | 'UNKNOWN'
  /**
   * Nothing in the target can identify this record, so no amount of asking will resolve it.
   *
   * The target assigned its own key, no unique key is mapped, and the only honest answer is to stop and
   * ask a person. Not a gap in the protocol — the answer to a question that has none automatically.
   */
  | 'RECONCILIATION_REQUIRED';

export const WRITE_STATES: readonly WriteState[] = [
  'INTENDED',
  'CONFIRMED',
  'UNKNOWN',
  'RECONCILIATION_REQUIRED',
];

/**
 * States in which the record must not be written again.
 *
 * The load-bearing set. A record here may already be in the target, so re-processing it could create a
 * second copy — which is the whole failure this protocol exists to prevent.
 */
export const UNRESOLVED_WRITE_STATES: readonly WriteState[] = [
  'INTENDED',
  'UNKNOWN',
  'RECONCILIATION_REQUIRED',
];

export function isUnresolved(state: WriteState | null | undefined): boolean {
  return state != null && (UNRESOLVED_WRITE_STATES as readonly string[]).includes(state);
}

/** Whether a run may be called complete. It may not, while the fate of any record is unknown. */
export function blocksCompletion(state: WriteState | null | undefined): boolean {
  return isUnresolved(state);
}

export const WRITE_STATE_LABELS: Record<WriteState, { label: string; meaning: string }> = {
  INTENDED: {
    label: 'Write attempted',
    meaning:
      'The write was started and we have no answer. The record may or may not be in the target; it will be reconciled before anything else happens.',
  },
  CONFIRMED: {
    label: 'Confirmed',
    meaning: 'The target accepted the write and returned its identifier.',
  },
  UNKNOWN: {
    label: 'Outcome unknown',
    meaning:
      'The request may have been applied before the answer was lost. It will not be retried, because retrying could create a second record.',
  },
  RECONCILIATION_REQUIRED: {
    label: 'Needs reconciliation',
    meaning:
      'Nothing in the target can identify this record, so whether the write committed cannot be determined automatically. Somebody has to look.',
  },
};

/**
 * Why a write error does or does not tell us the record is absent.
 *
 * The distinction the whole protocol turns on. A server that answers "no" has told us the record is not
 * there. A connection that drops has told us nothing — and treating silence as a refusal is what makes a
 * retry dangerous.
 */
export type WriteVerdict =
  /** The server answered and rejected it. The record is not in the target. */
  | 'REJECTED'
  /** We have no answer. The record may be in the target. */
  | 'AMBIGUOUS';

const DEFINITELY_REJECTED = new Set([
  'VALIDATION',
  'FORBIDDEN',
  'NOT_FOUND',
  'REFERENCE_NOT_FOUND',
  'DUPLICATE_RECORD',
  'READ_ONLY_MODE',
  'AUTH_REQUIRED',
  /**
   * A rate limit is a refusal to start, not a lost answer.
   *
   * Dataverse's service protection limits and every 429 are decided before the request is executed, so
   * the record is definitively not written. This matters more than the exotic cases: throttling is the
   * most common transient error there is, and treating each one as unresolved would stop a large
   * migration dead on a target doing nothing worse than asking us to slow down.
   */
  'THROTTLED',
]);

/**
 * Classifies a write failure.
 *
 * Errors default to **ambiguous**, which is the safe direction: a code nobody has classified yet is
 * treated as "we do not know" rather than as "it definitely did not happen". The cost of being wrong
 * that way is a record that needs reconciling; the cost of the other way is a duplicate.
 */
export function verdictOf(code: string | null | undefined): WriteVerdict {
  if (!code) return 'AMBIGUOUS';
  // A code may arrive as `CODE:platformCode`; the family is what matters.
  const family = code.split(':')[0] ?? code;
  return DEFINITELY_REJECTED.has(family) ? 'REJECTED' : 'AMBIGUOUS';
}

/**
 * Whether repeating this operation is safe when its outcome is unknown.
 *
 * An update is idempotent: the same values written to the same primary key a second time leave the
 * target exactly as the first attempt did. A create is not: it has no key to collide with until the
 * target assigns one. The asymmetry is the reason an interrupted update is recoverable and an
 * interrupted create may not be.
 */
export function repeatIsSafe(operation: 'CREATE' | 'UPDATE'): boolean {
  return operation === 'UPDATE';
}

/** What evidence could identify a record in the target without guessing. */
export type ReconciliationEvidence =
  /** The target holds the source record's own identifier. */
  | 'PRESERVED_ID'
  /** A platform-enforced alternate key, mapped and complete for this record. */
  | 'ALTERNATE_KEY'
  /** Columns the plan nominated as a business key, complete for this record. */
  | 'BUSINESS_KEY'
  /** A target identifier was recorded before the failure. */
  | 'RECORDED_TARGET_ID'
  /** Nothing identifies this record uniquely. */
  | 'NONE';

export const EVIDENCE_LABELS: Record<ReconciliationEvidence, string> = {
  PRESERVED_ID: 'the record identifier the source supplied',
  ALTERNATE_KEY: 'the alternate key the target enforces',
  BUSINESS_KEY: 'the business key the plan configured',
  RECORDED_TARGET_ID: 'the target identifier captured before the failure',
  NONE: 'nothing that identifies this record uniquely',
};
