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

/**
 * Whether settling this record needs a person, as opposed to another attempt.
 *
 * The distinction that decides whether a retry is allowed. A record in doubt with something that could
 * identify it — a preserved id, an alternate key, a business key — is settled by the next attempt asking
 * the target. A record with nothing to identify it cannot be settled by any number of attempts, and the
 * only remaining evidence is somebody opening the target and looking.
 *
 * Used by the run status and by the retry gate, so they cannot disagree about what is blocked.
 */
export function needsHumanReconciliation(
  state: WriteState | null | undefined,
  evidence: ReconciliationEvidence | null | undefined,
): boolean {
  if (state === 'RECONCILIATION_REQUIRED') return true;
  if (!isUnresolved(state)) return false;
  return !evidence || evidence === 'NONE';
}

export const EVIDENCE_LABELS: Record<ReconciliationEvidence, string> = {
  PRESERVED_ID: 'the record identifier the source supplied',
  ALTERNATE_KEY: 'the alternate key the target enforces',
  BUSINESS_KEY: 'the business key the plan configured',
  RECORDED_TARGET_ID: 'the target identifier captured before the failure',
  NONE: 'nothing that identifies this record uniquely',
};

/**
 * What a person found when they opened the target and looked.
 *
 * Four answers, not two. `PRESENT` and `ABSENT` settle the record; the other two do not, and exist because
 * a person who looked and could not tell has to be able to say that. Forcing uncertain evidence into
 * success or failure is the same mistake as a run reporting a clean result because nothing failed: it
 * produces a confident record of something nobody established.
 */
export type ReconcileFinding =
  /** The record is in the target, and its identifier there is known. */
  | 'PRESENT'
  /** The record is not in the target, so the write never committed. A plain failure from here on. */
  | 'ABSENT'
  /** Somebody looked and could not tell. The record stays unresolved and the retry stays refused. */
  | 'UNCLEAR'
  /**
   * More than one record in the target matches.
   *
   * A finding in its own right: a duplicate is already there. Settling it means deciding which record is
   * the right one, or removing the others, which is work in the target rather than an answer to record here.
   */
  | 'MULTIPLE';

export const RECONCILE_FINDINGS: readonly ReconcileFinding[] = ['PRESENT', 'ABSENT', 'UNCLEAR', 'MULTIPLE'];

/** How each finding reads in the evidence the reconciliation leaves behind. */
export const RECONCILE_FINDING_NOTES: Record<ReconcileFinding, string> = {
  PRESENT: 'Found in the target',
  ABSENT: 'Not in the target',
  UNCLEAR: 'Looked in the target; could not tell',
  MULTIPLE: 'More than one matching record in the target',
};

/** What each finding settles, and what it leaves outstanding. */
export const RECONCILE_FINDING_LABELS: Record<
  ReconcileFinding,
  { label: string; consequence: string; settles: boolean }
> = {
  PRESENT: {
    label: 'It is in the target',
    consequence: 'The record counts as written by this run. Another attempt will not write it again.',
    settles: true,
  },
  ABSENT: {
    label: 'It is not in the target',
    consequence: 'The write never happened. Another attempt will write this record.',
    settles: true,
  },
  UNCLEAR: {
    label: 'I cannot tell',
    consequence: 'The record stays unresolved. A retry stays refused, because it could write a second copy.',
    settles: false,
  },
  MULTIPLE: {
    label: 'More than one record matches',
    consequence:
      'The record stays unresolved. Decide which target record is correct, or remove the others, then look again.',
    settles: false,
  },
};
