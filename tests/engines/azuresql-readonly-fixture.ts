/**
 * The pre-seeded fixture the read-only Azure SQL certification reads.
 *
 * Every number here is a fact about `docs/AZURE_SQL_READONLY_SETUP.md`'s seed script, and the suite
 * asserts against them rather than against whatever it happens to find. That is the point of a
 * read-only certification: the suite cannot create the conditions it needs, so the conditions have
 * to be written down somewhere both the script and the assertions can agree on.
 *
 * If the script changes, these change with it, and the suite fails loudly until they do.
 */
export const READONLY_FIXTURE = {
  schema: 'dvm_ro',
  peopleTable: 'dvm_ro.people',
  visitsTable: 'dvm_ro.visits',

  peopleColumns: ['people_id', 'person_code', 'full_name', 'email', 'credit_limit', 'opened_on', 'is_active'],
  peopleKeyColumn: 'people_id',
  duplicateKeyColumn: 'person_code',
  visitsForeignKey: 'people_id',
  amountColumn: 'amount',
  visitedOnColumn: 'visited_on',

  /** 60 people, 90 visits. Small enough to count by hand, large enough to need more than one page. */
  peopleRows: 60,
  visitsRows: 90,

  /**
   * `person_code` repeats: rows 49 to 60 reuse the first twelve codes.
   * 48 distinct values, 12 of them held twice, so 24 rows are in a collision.
   */
  distinctPersonCodes: 48,
  duplicateGroups: 12,
  duplicateRowsInCollision: 24,

  /** Every third row has no email: 20 of 60. Four more hold a value that is not an address. */
  nullEmails: 20,
  invalidEmails: 4,

  /** Every fifth row writes its credit limit as money-as-text: 12 of 60. */
  moneyAsText: 12,

  /** Every seventh name is padded with spaces: 9 of 60. */
  paddedNames: 9,

  /** Every ninth visit has no person: 10 of 90, which is a reference that resolves to nothing. */
  visitsWithoutPerson: 10,

  /**
   * SUM(amount) over the 90 visits, where amount = (i % 9) * 125.25 for i in 0..89.
   * Each residue 0..8 occurs exactly ten times, so the total is 10 * 125.25 * (0+1+…+8) = 45090.
   */
  amountSum: 45_090,
} as const;
