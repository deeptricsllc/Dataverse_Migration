import type {
  ComparisonFieldPairDto,
  ComparisonSuggestionDto,
  ComparisonTotalsDto,
} from '../../../shared/domain';
import {
  isKeyUsable,
  type AttributeMeta,
  type DvRecord,
  type TableMetadata,
  type TableSummary,
} from '../../../shared/metadata';
import { nameSimilarity } from './mapping';
import { typeCompatibility } from './type-compat';
import { displayValue, normalizeForCompare } from './values';

/**
 * Reconciling two datasets: the pure part.
 *
 * Everything here is a function of its arguments, because this is the part whose correctness has to
 * be provable by a test rather than by running a migration. The field-by-field value comparison is
 * deliberately NOT here — it lives in `compareRecords`, which validation already uses, and having
 * two implementations of "are these two values the same" is exactly the class of divergence this
 * product exists to prevent.
 *
 * What is here is the pairing: which record on the left is the same real-world thing as which
 * record on the right, and what to do when that question has no honest answer.
 */

/** ASCII unit separator: cannot appear in a rendered value, so a composite key is unambiguous. */
const KEY_SEPARATOR = '\u001f';

export interface KeyedSide {
  /** Key value → the single record holding it. Records with an unusable key are not in here. */
  byKey: Map<string, DvRecord>;
  /** Key value → how many records claimed it. Only keys claimed more than once. */
  duplicates: Map<string, number>;
  /** Records whose key was empty, and so could not identify anything. */
  blank: DvRecord[];
  /** Records read, including the excluded ones. */
  total: number;
  /** Records excluded because their key was blank or duplicated. */
  excluded: number;
}

/**
 * Builds the key for one record.
 *
 * Normalized with the same function the value comparison uses, so `" ACME "` and `"ACME"` are the
 * same customer, and a GUID matches regardless of case. A key part that normalizes to null makes
 * the whole key unusable: a record keyed on nothing cannot be matched to anything, and quietly
 * treating blank as a value would pair every such record with every other one.
 */
export function keyOf(
  record: DvRecord,
  fields: string[],
  attrs: ReadonlyMap<string, AttributeMeta>,
): string | null {
  const parts: string[] = [];
  for (const field of fields) {
    const attr = attrs.get(field);
    if (!attr) return null;
    const normalized = normalizeForCompare(attr, record.values[field] ?? undefined);
    if (normalized === null || normalized === '') return null;
    parts.push(String(normalized));
  }
  return parts.length ? parts.join(KEY_SEPARATOR) : null;
}

/** How a composite key reads in a report: the parts, separated visibly. */
export const renderKey = (key: string): string => key.split(KEY_SEPARATOR).join(' · ');

/**
 * Indexes one side by key.
 *
 * A duplicated key removes **every** record holding it, not just the second one. Keeping the first
 * would mean reporting a comparison result for a record chosen by read order, which is a guess
 * wearing the costume of a fact.
 */
export function indexSide(records: DvRecord[], keyFields: string[], meta: TableMetadata): KeyedSide {
  const attrs = new Map(meta.attributes.map((a) => [a.logicalName, a]));
  const byKey = new Map<string, DvRecord>();
  const counts = new Map<string, number>();
  const blank: DvRecord[] = [];

  for (const record of records) {
    const key = keyOf(record, keyFields, attrs);
    if (key === null) {
      blank.push(record);
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    byKey.set(key, record);
  }

  const duplicates = new Map<string, number>();
  for (const [key, n] of counts) {
    if (n > 1) {
      duplicates.set(key, n);
      byKey.delete(key);
    }
  }
  const duplicateRecords = [...duplicates.values()].reduce((a, b) => a + b, 0);
  return {
    byKey,
    duplicates,
    blank,
    total: records.length,
    excluded: blank.length + duplicateRecords,
  };
}

export interface PairingResult {
  /** Left record and the right record holding the same key, or null when there is none. */
  pairs: { key: string; left: DvRecord; right: DvRecord | null }[];
  /** Keys present on the right and on neither the left's index nor its duplicates. */
  onlyInRight: { key: string; right: DvRecord }[];
}

export function pairSides(left: KeyedSide, right: KeyedSide): PairingResult {
  const pairs: PairingResult['pairs'] = [];
  for (const [key, record] of left.byKey) {
    pairs.push({ key, left: record, right: right.byKey.get(key) ?? null });
  }
  const onlyInRight: PairingResult['onlyInRight'] = [];
  for (const [key, record] of right.byKey) {
    // A key that is duplicated on the left is not "only on the right" — it is a key we refused to
    // pair. Saying it exists on one side only would be a second wrong answer on top of the first.
    if (!left.byKey.has(key) && !left.duplicates.has(key)) onlyInRight.push({ key, right: record });
  }
  return { pairs, onlyInRight };
}

export const emptyComparisonTotals = (): ComparisonTotalsDto => ({
  leftRecords: 0,
  rightRecords: 0,
  leftExcluded: 0,
  rightExcluded: 0,
  matched: 0,
  different: 0,
  onlyInLeft: 0,
  onlyInRight: 0,
  duplicateKeys: 0,
  blankKeys: 0,
  fieldDifferences: 0,
});

export const addTotals = (a: ComparisonTotalsDto, b: ComparisonTotalsDto): ComparisonTotalsDto => ({
  leftRecords: a.leftRecords + b.leftRecords,
  rightRecords: a.rightRecords + b.rightRecords,
  leftExcluded: a.leftExcluded + b.leftExcluded,
  rightExcluded: a.rightExcluded + b.rightExcluded,
  matched: a.matched + b.matched,
  different: a.different + b.different,
  onlyInLeft: a.onlyInLeft + b.onlyInLeft,
  onlyInRight: a.onlyInRight + b.onlyInRight,
  duplicateKeys: a.duplicateKeys + b.duplicateKeys,
  blankKeys: a.blankKeys + b.blankKeys,
  fieldDifferences: a.fieldDifferences + b.fieldDifferences,
});

/**
 * Checks the identity documented on {@link ComparisonTotalsDto}.
 *
 * Called on every table result before it is stored, not only from tests: a totals block that does
 * not reconcile means records went missing between reading and reporting, and the one thing worse
 * than finding that in a test is shipping it to somebody reconciling their finance data.
 */
export function totalsReconcile(t: ComparisonTotalsDto): boolean {
  return (
    t.matched + t.different + t.onlyInLeft === t.leftRecords - t.leftExcluded &&
    t.matched + t.different + t.onlyInRight === t.rightRecords - t.rightExcluded
  );
}

// ---------------------------------------------------------------------------
// Proposing what to compare
// ---------------------------------------------------------------------------

/** Columns nobody wants in a comparison: they differ by design and drown the real findings. */
const NEVER_COMPARE = new Set([
  'createdon',
  'modifiedon',
  'createdby',
  'modifiedby',
  'versionnumber',
  'importsequencenumber',
  'overriddencreatedon',
  'timezoneruleversionnumber',
  'utcconversiontimezonecode',
]);

const bare = (name: string) =>
  name
    .replace(/^[a-z0-9]+_/, '')
    .replace(/^.*\./, '')
    .toLowerCase();

/** Table names that plausibly describe the same thing: `dbo.Customer` and `account`, say. */
export function suggestTablePairs(
  left: TableSummary[],
  right: TableSummary[],
): { left: TableSummary; right: TableSummary; score: number }[] {
  const out: { left: TableSummary; right: TableSummary; score: number }[] = [];
  const takenRight = new Set<string>();
  for (const l of left) {
    let best: { right: TableSummary; score: number } | null = null;
    for (const r of right) {
      if (takenRight.has(r.logicalName)) continue;
      const exact = bare(l.logicalName) === bare(r.logicalName);
      const score = exact
        ? 1
        : nameSimilarity(
            { logicalName: bare(l.logicalName), displayName: l.displayName } as AttributeMeta,
            { logicalName: bare(r.logicalName), displayName: r.displayName } as AttributeMeta,
          );
      if (score >= 0.72 && (!best || score > best.score)) best = { right: r, score };
    }
    if (best) {
      takenRight.add(best.right.logicalName);
      out.push({ left: l, right: best.right, score: best.score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

const comparableAttrs = (meta: TableMetadata) =>
  meta.attributes.filter((a) => !a.attributeOf && !NEVER_COMPARE.has(a.logicalName.toLowerCase()));

/** Field pairs with the same (or very similar) name and a type that can be compared. */
export function suggestFieldPairs(left: TableMetadata, right: TableMetadata): ComparisonFieldPairDto[] {
  const rights = comparableAttrs(right);
  const used = new Set<string>();
  const pairs: ComparisonFieldPairDto[] = [];
  for (const l of comparableAttrs(left)) {
    const exact = rights.find((r) => !used.has(r.logicalName) && bare(r.logicalName) === bare(l.logicalName));
    const match =
      exact ??
      rights.find(
        (r) => !used.has(r.logicalName) && nameSimilarity(l, r) >= 0.85 && typeCompatibility(l, r).compatible,
      );
    if (!match) continue;
    used.add(match.logicalName);
    pairs.push({ left: l.logicalName, right: match.logicalName });
  }
  return pairs;
}

/**
 * Proposes the key for a pair of tables.
 *
 * In preference order: a column pair that is unique and required on both sides, then the primary
 * id when both sides have one under the same name, then nothing — because a key that is merely
 * *probably* unique produces a comparison that is confidently wrong, and asking the person who
 * knows the data takes ten seconds.
 */
export function suggestKey(left: TableMetadata, right: TableMetadata): ComparisonFieldPairDto[] {
  const rightByBare = new Map(right.attributes.map((a) => [bare(a.logicalName), a]));

  const unique = left.attributes
    .filter((l) => {
      const r = rightByBare.get(bare(l.logicalName));
      return Boolean(r && isUniqueish(l, left) && isUniqueish(r, right));
    })
    .sort((a, b) => Number(b.isPrimaryId) - Number(a.isPrimaryId));
  if (unique.length) {
    const l = unique[0];
    return [{ left: l.logicalName, right: rightByBare.get(bare(l.logicalName))!.logicalName }];
  }
  return [];
}

/**
 * Unique enough to identify a record: the primary id, or a column carrying a usable single-column
 * alternate key. A key whose unique index is still building is not usable, which `isKeyUsable`
 * already decides for the rest of the product.
 */
function isUniqueish(attr: AttributeMeta, meta: TableMetadata): boolean {
  if (attr.isPrimaryId) return true;
  return meta.keys.some(
    (k) => isKeyUsable(k) && k.attributes.length === 1 && k.attributes[0] === attr.logicalName,
  );
}

export function buildSuggestion(
  left: TableMetadata,
  right: TableMetadata,
  rationale: string,
): ComparisonSuggestionDto {
  const key = suggestKey(left, right);
  const fields = suggestFieldPairs(left, right).filter(
    (f) => !key.some((k) => k.left === f.left || k.right === f.right),
  );
  return {
    leftTable: left.logicalName,
    rightTable: right.logicalName,
    displayName: `${left.displayName} ↔ ${right.displayName}`,
    key,
    fields,
    keyProposed: key.length > 0,
    rationale: key.length
      ? `${rationale}. Matching on ${key.map((k) => k.left).join(' + ')}, comparing ${fields.length} column(s).`
      : `${rationale}. No column on both sides is guaranteed unique, so choose the one that identifies a record before running this.`,
  };
}

/** Columns that exist on one side and not the other: the "missing fields" answer. */
export function fieldGaps(
  left: TableMetadata,
  right: TableMetadata,
): { onlyInLeft: string[]; onlyInRight: string[] } {
  const rightBare = new Set(comparableAttrs(right).map((a) => bare(a.logicalName)));
  const leftBare = new Set(comparableAttrs(left).map((a) => bare(a.logicalName)));
  return {
    onlyInLeft: comparableAttrs(left)
      .filter((a) => !rightBare.has(bare(a.logicalName)))
      .map((a) => a.logicalName)
      .sort(),
    onlyInRight: comparableAttrs(right)
      .filter((a) => !leftBare.has(bare(a.logicalName)))
      .map((a) => a.logicalName)
      .sort(),
  };
}

/** A value as it appears in a report, masking secured columns exactly as every other export does. */
export const reportValue = (attr: AttributeMeta | undefined, record: DvRecord, field: string) =>
  displayValue(attr, record.values[field] ?? undefined);
