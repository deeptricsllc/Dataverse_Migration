/**
 * What a recorded failure code means, where the product knows.
 *
 * Every category here is an error code the engine actually writes to `migration_errors`. Nothing is
 * inferred from a message, and nothing is grouped by resemblance: a category that is not an outcome the
 * engine recorded would be a guess presented beside real counts, which is the one thing a failure report
 * must not contain.
 *
 * A code this table does not know is shown as itself. That is the honest answer, and it is also the
 * useful one — a connector's own code is what a person searches for in the target's documentation.
 *
 * Codes can arrive as `CODE:platformCode`, where the platform code is the target system's own. The
 * prefix is the category; the remainder is evidence and is kept.
 */

export interface FailureCategory {
  /** The code as recorded, including any platform suffix. */
  code: string;
  /** What to show as the heading. The code itself when this product did not define it. */
  label: string;
  /** What it means for the records in it. Null when the code is not one this product defines. */
  meaning: string | null;
  /** What to do about it. Null when the product cannot say without guessing. */
  action: string | null;
  /** True when the label came from this table rather than from the code itself. */
  known: boolean;
}

/**
 * The codes this product defines, and what each one means for the records that carry it.
 *
 * The wording follows `docs/PRODUCT_LANGUAGE_STANDARD.md`: state, consequence, action, in short
 * sentences, with no personification.
 */
const KNOWN: Record<string, { label: string; meaning: string; action: string }> = {
  LOOKUP_UNRESOLVED: {
    label: 'Lookup not resolved',
    meaning: 'The referenced record does not exist in the target.',
    /*
     * Both halves matter. Migrating the referenced table is not enough on its own for a record that is
     * already in the target without the reference: a run whose strategy skips a match leaves it exactly as
     * it is. Setting the reference needs a run that updates records that already match.
     */
    action:
      'Add the referenced table to the migration. Records already in the target need a run that updates records that already match.',
  },
  LOOKUP_PENDING_MIGRATION: {
    label: 'Lookup waiting for a later table',
    meaning: 'The referenced record is migrated later in the load order.',
    action: 'The second pass sets these references. Check the dependency order.',
  },
  ALREADY_EXISTS: {
    label: 'Record already exists in the target',
    meaning: 'A matching target record was found and this strategy does not change it.',
    action: 'Change the conflict strategy if these records should be updated.',
  },
  AMBIGUOUS_TARGET_MATCH: {
    label: 'More than one target record matches',
    meaning: 'The identity value matches several target records. A match would be a guess.',
    action: 'Remove the duplicates in the target, or use a more specific key.',
  },
  DUPLICATE_SOURCE_KEY: {
    label: 'Duplicate identity key in the source',
    meaning: 'Two source records share the same identity value.',
    action: 'Correct the source data, or select a key that is unique.',
  },
  ALTERNATE_KEY_MISSING: {
    label: 'Alternate key not configured',
    meaning: 'The match strategy needs an alternate key that the target does not define.',
    action: 'Define the alternate key in the target, or select a different match strategy.',
  },
  BUSINESS_KEY_NOT_CONFIGURED: {
    label: 'Business key not configured',
    meaning: 'The match strategy is business key, and no fields are selected.',
    action: 'Select the fields that identify a record.',
  },
  BUSINESS_KEY_INCOMPLETE: {
    label: 'Business key value missing',
    meaning: 'A field of the business key is empty in the source record.',
    action: 'Correct the source data, or select a key whose fields are always present.',
  },
  MAPPING_INVALID: {
    label: 'Mapping is not valid',
    meaning: 'The configured mapping cannot be applied to this record.',
    action: 'Open the mapping and correct the field.',
  },
  PRINCIPAL_UNRESOLVED: {
    label: 'Owner not found in the target',
    meaning: 'The source owner has no approved mapping to a target user or team.',
    action: 'Map the owner, or set a fallback identity.',
  },
  PRINCIPAL_FALLBACK_APPLIED: {
    label: 'Owner replaced by the fallback identity',
    meaning: 'The source owner has no mapping. The fallback identity owns the record.',
    action: 'Map the owner if the original attribution matters.',
  },
  TABLE_UNAVAILABLE: {
    label: 'Table could not be read',
    meaning: 'The source table did not return records.',
    action: 'Test the connection, then run the migration again.',
  },
  VALIDATION: {
    label: 'The target rejected the value',
    meaning: 'The target refused the record and returned a validation error.',
    action: 'Read the message, then correct the mapping, the transformation or the source value.',
  },
  DUPLICATE_RECORD: {
    label: 'The target reported a duplicate',
    meaning: 'A duplicate detection rule in the target refused the record.',
    action: 'Review the duplicate rule in the target, or update the existing record instead.',
  },
  REFERENCE_NOT_FOUND: {
    label: 'Referenced record not found in the target',
    meaning: 'The target could not resolve a reference this record carries.',
    action: 'Migrate the referenced table first.',
  },
  FORBIDDEN: {
    label: 'Permission denied',
    meaning: 'The account does not have permission for this operation.',
    action: 'Grant the account the required role in the target.',
  },
  AUTH_REQUIRED: {
    label: 'Authentication required',
    meaning: 'The target refused the request because the session is not authenticated.',
    action: 'Sign in again, then retry.',
  },
  THROTTLED: {
    label: 'The target throttled the request',
    meaning: 'The target limited the request rate.',
    action: 'Retry these records. Reduce the batch size if it continues.',
  },
  TIMEOUT: {
    label: 'The request timed out',
    meaning: 'The target did not answer in time.',
    action: 'Retry these records.',
  },
  NETWORK: {
    label: 'The target could not be reached',
    meaning: 'The connection to the target failed.',
    action: 'Test the connection, then retry.',
  },
  NOT_FOUND: {
    label: 'Not found in the target',
    meaning: 'The target reported that the record or table does not exist.',
    action: 'Check the table mapping.',
  },
  READ_ONLY_MODE: {
    label: 'This deployment is read-only',
    meaning: 'The write guard refused the operation.',
    action: 'Use a target this deployment may write to.',
  },
  SERVER_ERROR: {
    label: 'The target returned a server error',
    meaning: 'The target failed to process the request.',
    action: 'Retry these records. Check the target if it continues.',
  },
};

/**
 * The warning codes that mean the target's data is not what the source said.
 *
 * A warning does not fail a record, and most warnings do not change the data either: a record skipped
 * under a conflict strategy is the engine doing what it was told, and a lookup waiting for a later table
 * is resolved by the pass that follows it. Reporting those as a degraded run would teach people that the
 * run outcome is noise, which is worse than not reporting it at all.
 *
 * These three are different. Each one means a record is in the target carrying less than the source
 * record did, and each one changes the run's outcome to `COMPLETED_WITH_WARNINGS`. The list is a list
 * rather than a rule because the decision belongs to what each code means.
 *
 * See `docs/MIGRATION_OUTCOME_SEMANTICS.md` §5.3.
 */
export const MATERIAL_WARNING_CODES: readonly string[] = [
  // A relationship the source record had is not in the target record.
  'LOOKUP_UNRESOLVED',
  // The owner was not carried across, and no replacement was chosen.
  'PRINCIPAL_UNRESOLVED',
];

/**
 * Warnings that mean the data differs *because somebody asked for it to*.
 *
 * `PRINCIPAL_FALLBACK_APPLIED` is the clearest case and the reason this distinction is written down. The
 * owner on the target record is not the owner on the source record — a real difference — but the identity
 * that replaced it was named in the plan, raised as a plan issue, and acknowledged before the run started.
 * Reporting that as a degraded outcome would mark every run into a tenant with no user mapping as
 * incomplete, for the rest of the project, for doing exactly what it was configured to do.
 *
 * The test is not "is the data different". It is "was this asked for". Nobody asks for a relationship to
 * be dropped; somebody does ask for unmapped owners to fall back to a named identity.
 *
 * Kept as a named list rather than left as an absence, so the next person adding a warning code has to
 * decide which of the two it is.
 */
export const CONFIGURED_WARNING_CODES: readonly string[] = [
  // An identity the plan names, after the plan raised it and the person acknowledged it.
  'PRINCIPAL_FALLBACK_APPLIED',
  // A match was found and the conflict strategy is to leave it alone.
  'ALREADY_EXISTS',
];

/**
 * Whether a recorded warning code means the migrated data differs from the source.
 *
 * Takes the code as recorded, including any `CODE:platformCode` suffix, because that is the form the
 * error rows hold.
 */
export function isMaterialWarning(code: string): boolean {
  return MATERIAL_WARNING_CODES.includes(code.split(':')[0] ?? code);
}

/** The category of one recorded code. Unknown codes are returned as themselves, never guessed at. */
export function describeFailureCode(code: string): FailureCategory {
  // `CODE:platformCode` — the prefix is the category, the rest is the target's own code.
  const prefix = code.split(':')[0] ?? code;
  const known = KNOWN[prefix];
  if (!known) return { code, label: code, meaning: null, action: null, known: false };
  return { code, label: known.label, meaning: known.meaning, action: known.action, known: true };
}

/**
 * Where a failure is fixed.
 *
 * Not advice — a destination. `action` on a category says what to do; this says where to do it, and only
 * for the codes where a place in this product actually changes the outcome. A code that is not here gets
 * no button, because an action that leads somewhere unrelated is worse than no action: it costs the person
 * the trip and teaches them not to trust the next one.
 *
 * Retrying is deliberately absent. A throttled or timed-out record is fixed by running it again, which the
 * run page already offers, and a second retry control on the same screen is a second thing to reason about.
 */
export type CorrectionTarget =
  /** The datasets in this migration: add the table the reference points at. */
  | 'SOURCE_DATA'
  /** Field mapping for this dataset. */
  | 'MAPPING'
  /** How records are matched in the target: identity strategy, keys, conflict strategy. */
  | 'MATCHING'
  /** Which target user or team each source owner becomes. */
  | 'OWNERS'
  /** The connection itself: permission, authentication, read-only. */
  | 'CONNECTION'
  /** The load order and which references are deferred. */
  | 'DEPENDENCIES';

const CORRECTIONS: Record<string, { target: CorrectionTarget; label: string }> = {
  LOOKUP_UNRESOLVED: { target: 'SOURCE_DATA', label: 'Add the referenced table' },
  REFERENCE_NOT_FOUND: { target: 'SOURCE_DATA', label: 'Add the referenced table' },
  LOOKUP_PENDING_MIGRATION: { target: 'DEPENDENCIES', label: 'Review the load order' },
  MAPPING_INVALID: { target: 'MAPPING', label: 'Open the mapping' },
  VALIDATION: { target: 'MAPPING', label: 'Open the mapping' },
  NOT_FOUND: { target: 'MAPPING', label: 'Check the table mapping' },
  AMBIGUOUS_TARGET_MATCH: { target: 'MATCHING', label: 'Change how records are matched' },
  DUPLICATE_SOURCE_KEY: { target: 'MATCHING', label: 'Change how records are matched' },
  ALTERNATE_KEY_MISSING: { target: 'MATCHING', label: 'Change how records are matched' },
  BUSINESS_KEY_NOT_CONFIGURED: { target: 'MATCHING', label: 'Select the identifying fields' },
  BUSINESS_KEY_INCOMPLETE: { target: 'MATCHING', label: 'Select the identifying fields' },
  ALREADY_EXISTS: { target: 'MATCHING', label: 'Change the conflict strategy' },
  DUPLICATE_RECORD: { target: 'MATCHING', label: 'Change the conflict strategy' },
  PRINCIPAL_UNRESOLVED: { target: 'OWNERS', label: 'Map the owner' },
  PRINCIPAL_FALLBACK_APPLIED: { target: 'OWNERS', label: 'Map the owner' },
  FORBIDDEN: { target: 'CONNECTION', label: 'Open the connection' },
  AUTH_REQUIRED: { target: 'CONNECTION', label: 'Open the connection' },
  READ_ONLY_MODE: { target: 'CONNECTION', label: 'Open the connection' },
  TABLE_UNAVAILABLE: { target: 'CONNECTION', label: 'Open the connection' },
};

/**
 * Where this failure is fixed, or null when this product has no place that fixes it.
 *
 * Null is a real answer, and it is the one for a throttled request, a timeout, a lost connection and a
 * server error: nothing in the configuration is wrong, so there is nothing to open.
 */
export function correctionFor(code: string): { target: CorrectionTarget; label: string } | null {
  return CORRECTIONS[code.split(':')[0] ?? code] ?? null;
}
