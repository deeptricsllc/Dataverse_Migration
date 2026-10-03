/**
 * What kind of uniqueness a duplicate scan actually tested.
 *
 * A duplicate check is the only check that can catch a migration which wrote every record twice:
 * value comparison cannot see it, because each source record finds a target record holding exactly
 * the right values — just not only one of them. So the check matters. But *which columns* it grouped
 * on decides what finding nothing proves, and those two things were being reported as one.
 *
 * The case that made this necessary: with no alternate or business key configured, the scan falls
 * back to the target's own primary id and then reports "No repeated values of dtx_regionid in the
 * target." Which is true, and worthless — the target refuses a repeated primary key by itself, so
 * that sentence is a restatement of the platform's guarantee, not evidence about the data. Read
 * quickly, next to a row of passes, it says "no duplicates". The product only proved "no duplicate
 * primary keys".
 *
 * So the basis travels with the finding, and nothing in the report says "no duplicates" when what
 * was tested was a key the target was always going to keep unique.
 */
export const UNIQUENESS_BASES = [
  /** The target's own primary id. The target enforces it, so finding none proves nothing about data. */
  'PRIMARY_KEY',
  /** A key the target declares and enforces, chosen by whoever configured the table. */
  'ALTERNATE_KEY',
  /** One column this migration matched records on. Not necessarily enforced by anything. */
  'BUSINESS_KEY',
  /** Several columns this migration matched on, together. */
  'COMPOSITE_BUSINESS_KEY',
  /** No scan happened, or it could not be trusted. The reason says which. */
  'NOT_VERIFIED',
] as const;

export type UniquenessBasis = (typeof UNIQUENESS_BASES)[number];

export interface UniquenessCheck {
  basis: UniquenessBasis;
  /** The columns grouped on. Empty when nothing was tested. */
  columns: string[];
  /**
   * True when the system holding the data refuses a repeat by itself. Finding none is then a
   * restatement of that guarantee rather than a finding about the migration.
   */
  enforcedByTarget: boolean;
  /**
   * Whether this check can support a claim about business-level uniqueness. False for a primary key
   * and for anything not verified — the two cases a report must never present as "no duplicates".
   */
  provesBusinessUniqueness: boolean;
  /** One sentence for the report: what finding nothing here does and does not establish. */
  proves: string;
}

/** The short label a report or a column header uses. */
export const UNIQUENESS_LABELS: Record<UniquenessBasis, string> = {
  PRIMARY_KEY: 'Primary key only',
  ALTERNATE_KEY: 'Alternate key',
  BUSINESS_KEY: 'Business key',
  COMPOSITE_BUSINESS_KEY: 'Composite business key',
  NOT_VERIFIED: 'Not verified',
};

/**
 * Describes what a scan over these columns can and cannot show.
 *
 * Pure, so the sentence a customer reads and the sentence a test asserts are the same sentence.
 */
export function describeUniqueness(
  basis: UniquenessBasis,
  columns: string[],
  options: { reason?: string } = {},
): UniquenessCheck {
  const list = columns.join(' + ');
  switch (basis) {
    case 'PRIMARY_KEY':
      return {
        basis,
        columns,
        enforcedByTarget: true,
        provesBusinessUniqueness: false,
        proves:
          `Only the target's own primary key (${list}) was checked, and the target refuses a repeat ` +
          'of it by itself. This does not show that the business data is unique. Configure an ' +
          'alternate key or a business key for this table to have that checked.',
      };
    case 'ALTERNATE_KEY':
      return {
        basis,
        columns,
        enforcedByTarget: true,
        provesBusinessUniqueness: true,
        proves:
          `Grouped on the alternate key ${list}, which the target declares and enforces. Finding no ` +
          'repeats means no two records in the target share it.',
      };
    case 'BUSINESS_KEY':
    case 'COMPOSITE_BUSINESS_KEY':
      return {
        basis,
        columns,
        enforcedByTarget: false,
        provesBusinessUniqueness: true,
        proves:
          `Grouped on ${list}, the ${basis === 'BUSINESS_KEY' ? 'column' : 'columns'} this migration ` +
          'matched records on. The target does not enforce it, so this is a real test of whether the ' +
          'migration left two records where there should be one.',
      };
    case 'NOT_VERIFIED':
      return {
        basis,
        columns,
        enforcedByTarget: false,
        provesBusinessUniqueness: false,
        proves: options.reason
          ? `No uniqueness was verified for this table. ${options.reason}`
          : 'No uniqueness was verified for this table.',
      };
  }
}

/**
 * Picks the basis from what the plan configured, which is the only honest source: inventing a
 * uniqueness expectation the customer never stated would produce findings about data that was always
 * allowed to repeat.
 */
export function basisFor(input: {
  matchStrategy: string | null | undefined;
  businessKeyFields: string[];
  alternateKeyColumns: string[];
}): { basis: UniquenessBasis; columns: string[] } | null {
  if (input.matchStrategy === 'BUSINESS_KEY' && input.businessKeyFields.length > 0) {
    return {
      basis: input.businessKeyFields.length > 1 ? 'COMPOSITE_BUSINESS_KEY' : 'BUSINESS_KEY',
      columns: input.businessKeyFields,
    };
  }
  if (input.matchStrategy === 'ALTERNATE_KEY' && input.alternateKeyColumns.length > 0) {
    // Stays ALTERNATE_KEY however many columns it spans: a multi-column alternate key is still one
    // key the target declares and enforces, which is a different claim from columns we chose to
    // group on ourselves.
    return { basis: 'ALTERNATE_KEY', columns: input.alternateKeyColumns };
  }
  return null;
}
