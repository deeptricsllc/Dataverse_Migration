import type { FieldProfileDto, TableProfileDto } from './domain';
import type { Finding } from './findings';

/**
 * Which tables reference which, worked out from the data when nobody wrote it down.
 *
 * A file export has no foreign keys. The relationships are still there — orders carry a customer
 * number, contacts carry a customer number — and a migration that does not know about them loads
 * the children before the parents, or loads children whose parents never arrive. The purpose here
 * is to find those edges and, just as importantly, to say how confident the finding is.
 *
 * Three classifications, and they are not decoration:
 *
 *   DECLARED  the source says so. A Dataverse lookup, or a declared dependency.
 *   INFERRED  the data says so, strongly: the names agree, the types agree, the parent column is a
 *             real key, and every child value exists in the parent.
 *   REVIEW    there is evidence and it is not conclusive. Shown as a question, never as a fact.
 *
 * An inferred relationship is never presented as a confirmed foreign key. The distinction is the
 * whole value of the feature: acting on a wrong relationship means loading in the wrong order, and
 * a reader who cannot tell which of these they are looking at will act on all of them equally.
 */

export type RelationshipConfidence = 'DECLARED' | 'INFERRED' | 'REVIEW';

export interface RelationshipInput {
  dataset: string;
  profile: TableProfileDto;
  /**
   * Tables this one is declared to depend on, where the source says so. Empty for a file.
   *
   * Table-level rather than column-level, because that is what the analysis record carries. It
   * confirms that these two tables are related; which column carries the reference still has to
   * come from the data, so a declaration raises confidence but does not by itself name the edge.
   */
  declaredTables?: string[];
}

export interface DiscoveredRelationship {
  childDataset: string;
  childTable: string;
  childColumn: string;
  parentDataset: string;
  parentTable: string;
  parentColumn: string;
  confidence: RelationshipConfidence;
  /** Distinct child values found in the parent, over distinct child values. */
  coverage: number;
  /** Child records whose value is not present in the parent column. */
  orphanRecords: number;
  /** Distinct child values not present in the parent column, worst first. Capped. */
  orphanValues: string[];
  /** Why this was proposed, in the order the reasoning ran. */
  evidence: string[];
  /** True when either sample was incomplete, so coverage is an estimate. */
  estimated: boolean;
}

/** How much of the child has to resolve before the edge is worth calling a relationship. */
const INFERRED_COVERAGE = 0.98;
const REVIEW_COVERAGE = 0.5;
/** A parent column this far from unique is not a key, whatever it is called. */
const PARENT_UNIQUENESS = 0.99;
const MAX_ORPHAN_EXAMPLES = 5;

/** `Customer_Number` and `customernumber` are the same name wearing different clothes. */
function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** `customers` and `customer` are the same table. */
function singular(name: string): string {
  const n = normalise(name);
  return n.endsWith('ies') ? `${n.slice(0, -3)}y` : n.endsWith('s') ? n.slice(0, -1) : n;
}

/**
 * How strongly two column names, in their two tables, suggest a reference.
 *
 * Name agreement alone proves nothing — two tables can both have a `code` that means different
 * things — so this is one input of several rather than a decision.
 */
function nameAffinity(child: FieldProfileDto, parent: FieldProfileDto, parentTable: string): number {
  const c = normalise(child.field);
  const p = normalise(parent.field);
  if (c === p) return 1;
  const table = singular(parentTable);
  // orders.customerid -> customers.id, orders.customer_number -> customers.number
  if (c === `${table}${p}` || c === `${table}id` || c === `${table}code` || c === `${table}ref`) return 1;
  if (
    c.includes(table) &&
    (c.endsWith('id') || c.endsWith('number') || c.endsWith('code') || c.endsWith('ref'))
  )
    return 0.8;
  return 0;
}

/** Text joins to text and number joins to number. A date is not a key. */
function typesCompatible(a: FieldProfileDto, b: FieldProfileDto): boolean {
  const family = (f: FieldProfileDto) =>
    f.type === 'Lookup' || f.type === 'Uniqueidentifier'
      ? 'ref'
      : f.type === 'String' || f.type === 'Memo'
        ? 'text'
        : f.type === 'Integer' || f.type === 'BigInt' || f.type === 'Decimal' || f.type === 'Money'
          ? 'number'
          : 'other';
  const fa = family(a);
  const fb = family(b);
  if (fa === 'other' || fb === 'other') return false;
  // A reference column can point at either, and text identifiers are routinely stored as numbers
  // on one side and strings on the other, which is itself worth knowing about.
  return (
    fa === fb ||
    fa === 'ref' ||
    fb === 'ref' ||
    (fa === 'text' && fb === 'number') ||
    (fa === 'number' && fb === 'text')
  );
}

/**
 * Unique and populated enough to be the thing a child points at.
 *
 * At least two distinct values, because a column holding one value is unique by arithmetic rather
 * than by design and identifies nothing. Without this a one-row table looks like a perfect parent,
 * and every other table in the project appears to reference it.
 */
function isParentKey(f: FieldProfileDto): boolean {
  if (f.examined === 0 || f.distinctCount === null) return false;
  if (f.distinctCount < 2) return false;
  if (f.nullCount + f.blankCount > 0) return false;
  return f.distinctCount / f.examined >= PARENT_UNIQUENESS;
}

export function discoverRelationships(inputs: RelationshipInput[]): DiscoveredRelationship[] {
  const found: DiscoveredRelationship[] = [];
  if (inputs.length < 2) return found;

  for (const child of inputs) {
    for (const parent of inputs) {
      if (child === parent) continue;
      for (const childCol of child.profile.fields) {
        const childSample = childCol.valueSample;
        if (!childSample || childSample.values.length === 0) continue;

        for (const parentCol of parent.profile.fields) {
          const parentSample = parentCol.valueSample;
          if (!parentSample || parentSample.values.length === 0) continue;
          if (!typesCompatible(childCol, parentCol)) continue;

          const tablesDeclared = (child.declaredTables ?? []).includes(parent.profile.table);
          const affinity = nameAffinity(childCol, parentCol, parent.profile.displayName);
          const parentIsKey = isParentKey(parentCol);
          /*
           * A table-level declaration confirms the two tables are related; it does not say through
           * which column. So the column evidence is still required, and a declaration promotes the
           * result rather than replacing the reasoning.
           */
          const declared = tablesDeclared && affinity > 0 && parentIsKey;
          // Nothing to go on: no name agreement, or no key to point at.
          if (affinity === 0 || !parentIsKey) continue;

          const parentValues = new Set(parentSample.values.map((v) => v.value ?? ''));
          let matchedValues = 0;
          let orphanRecords = 0;
          const orphans: { value: string; count: number }[] = [];
          for (const { value, count } of childSample.values) {
            if (parentValues.has(value ?? '')) matchedValues++;
            else {
              orphanRecords += count;
              orphans.push({ value: value ?? '', count });
            }
          }
          const distinctChildValues = childSample.values.length;
          const coverage = distinctChildValues === 0 ? 0 : matchedValues / distinctChildValues;
          if (coverage < REVIEW_COVERAGE) continue;

          /*
           * A truncated sample on either side makes coverage a lower bound: a child value might
           * exist in a part of the parent we did not keep. Those are never promoted to INFERRED,
           * because an orphan count that might be an artefact of sampling is worse than no count.
           */
          const estimated = childSample.truncated || parentSample.truncated;
          const confidence: RelationshipConfidence = declared
            ? 'DECLARED'
            : !estimated && affinity >= 0.8 && parentIsKey && coverage >= INFERRED_COVERAGE
              ? 'INFERRED'
              : 'REVIEW';

          found.push({
            childDataset: child.dataset,
            childTable: child.profile.displayName,
            childColumn: childCol.field,
            parentDataset: parent.dataset,
            parentTable: parent.profile.displayName,
            parentColumn: parentCol.field,
            confidence,
            coverage,
            orphanRecords,
            orphanValues: orphans
              .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1))
              .slice(0, MAX_ORPHAN_EXAMPLES)
              .map((o) => o.value),
            estimated,
            evidence: [
              declared
                ? `The source declares that ${child.profile.displayName} depends on ${parent.profile.displayName}.`
                : affinity === 1
                  ? `${childCol.field} and ${parentCol.field} name the same thing.`
                  : `${childCol.field} is named after ${parent.profile.displayName}.`,
              parentIsKey
                ? `${parentCol.field} is unique and populated across all ${parentCol.examined.toLocaleString()} records of ${parent.profile.displayName}, so it can be pointed at.`
                : `${parentCol.field} is not unique in ${parent.profile.displayName}, so a child value does not identify one parent record.`,
              `${matchedValues.toLocaleString()} of ${distinctChildValues.toLocaleString()} distinct ${childCol.field} values exist in ${parent.profile.displayName}.`,
              ...(estimated
                ? [
                    'One of the columns had more distinct values than are kept for comparison, so this coverage is a lower bound.',
                  ]
                : []),
            ],
          });
        }
      }
    }
  }
  return found;
}

/**
 * The findings a reader sees, from the relationships discovered.
 *
 * Two kinds, deliberately. Finding a relationship is good news and does not count against
 * readiness. Finding records that point at a parent which does not exist is a defect, and it is the
 * one that stops a migration: those rows either fail on a required reference or load with the
 * reference quietly empty.
 */
export function relationshipFindings(inputs: RelationshipInput[]): Finding[] {
  const out: Finding[] = [];
  for (const rel of discoverRelationships(inputs)) {
    const edge = `${rel.childTable}.${rel.childColumn} → ${rel.parentTable}.${rel.parentColumn}`;
    const pct = Math.round(rel.coverage * 1000) / 10;

    if (rel.orphanRecords > 0 && !rel.estimated) {
      out.push({
        id: `ORPHAN_REFERENCES:${rel.childTable}:${rel.childColumn}:${rel.parentTable}`,
        category: 'RELATIONSHIPS',
        severity: 'WARNING',
        title: `${rel.childColumn} points at ${rel.parentTable} records that are not there`,
        summary:
          `${rel.orphanRecords.toLocaleString()} records in ${rel.childTable} carry a ${rel.childColumn} ` +
          `that does not exist in ${rel.parentTable}. ${pct}% of the distinct values resolve.`,
        dataset: rel.childDataset,
        table: rel.childTable,
        columns: [rel.childColumn],
        affected: rel.orphanRecords,
        affectedPercent: null,
        evidence: [
          ...rel.evidence,
          `Values with no match: ${rel.orphanValues.join(', ')}.`,
          rel.confidence === 'DECLARED'
            ? 'The relationship is declared by the source, so these are genuine breaks rather than a guess about which columns are related.'
            : 'This relationship is inferred from the data, so confirm the columns are related before treating the unmatched values as broken.',
        ],
        whyItMatters:
          'A record whose parent is missing cannot be linked after migration. Where the reference is required the record is rejected; where it is optional it loads with the link empty, which is worse, because the data looks complete and the relationship is gone.',
        recommendation: `Decide what the unmatched ${rel.childColumn} values are before migrating: a parent that was not exported, a typo, or a record that should not be migrated at all. Export the missing parents, correct the values, or exclude the children deliberately.`,
        migrationImpact:
          'These records fail on a required lookup, or migrate with an empty reference that nobody notices until something tries to follow it.',
        confidence: rel.confidence === 'DECLARED' ? 'HIGH' : 'MEDIUM',
        basis: 'EXACT',
      });
    }

    out.push({
      id: `RELATIONSHIP:${rel.childTable}:${rel.childColumn}:${rel.parentTable}:${rel.parentColumn}`,
      category: 'RELATIONSHIPS',
      severity: 'INFO',
      title:
        rel.confidence === 'DECLARED'
          ? `${edge}, declared by the source`
          : rel.confidence === 'INFERRED'
            ? `${edge}, inferred from the data`
            : `${edge} — possible, needs a person to confirm`,
      summary:
        rel.confidence === 'REVIEW'
          ? `${rel.childColumn} may reference ${rel.parentTable}.${rel.parentColumn}: ${pct}% of its distinct values exist there. The evidence is not strong enough to rely on.`
          : `${rel.childColumn} references ${rel.parentTable}.${rel.parentColumn}. ${pct}% of its distinct values exist there.`,
      dataset: rel.childDataset,
      table: rel.childTable,
      columns: [rel.childColumn],
      affected: 0,
      affectedPercent: null,
      evidence: [
        ...rel.evidence,
        rel.confidence === 'DECLARED'
          ? 'Confirmed by source metadata.'
          : rel.confidence === 'INFERRED'
            ? 'Inferred from names, types, uniqueness and value overlap. Not a declared foreign key.'
            : 'Proposed for review. Not a declared foreign key, and not strong enough to infer one.',
      ],
      whyItMatters:
        'Migration order follows relationships. Parents have to exist before the children that point at them, and a relationship nobody recorded is one the run will discover by failing.',
      recommendation:
        rel.confidence === 'REVIEW'
          ? `Confirm with somebody who knows the source whether ${rel.childColumn} is meant to reference ${rel.parentTable}. If it is, the unmatched values need a decision; if it is not, nothing here applies.`
          : `Migrate ${rel.parentTable} before ${rel.childTable}, and keep the reference mapped.`,
      migrationImpact:
        'Loading the child first leaves references pointing at records that do not exist yet, which either fails the row or stores an empty link.',
      confidence: rel.confidence === 'DECLARED' ? 'HIGH' : 'MEDIUM',
      basis: 'EXACT',
      // Discovering a relationship is not a defect. Only the broken references are.
      deducts: false,
    });
  }
  return out;
}
