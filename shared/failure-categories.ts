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
    action: 'Migrate the referenced table, or correct the source reference.',
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

/** The category of one recorded code. Unknown codes are returned as themselves, never guessed at. */
export function describeFailureCode(code: string): FailureCategory {
  // `CODE:platformCode` — the prefix is the category, the rest is the target's own code.
  const prefix = code.split(':')[0] ?? code;
  const known = KNOWN[prefix];
  if (!known) return { code, label: code, meaning: null, action: null, known: false };
  return { code, label: known.label, meaning: known.meaning, action: known.action, known: true };
}
