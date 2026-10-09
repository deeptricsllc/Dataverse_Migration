import {
  FINDING_CATEGORY_LABELS,
  findingDeducts,
  type Finding,
  type FindingCategory,
  type FindingSeverity,
} from './findings';

/**
 * How ready this data is to be migrated, and exactly why.
 *
 * ## The rule that shapes everything here
 *
 * **Every point deducted names the finding that deducted it.** A number nobody can take apart is decoration,
 * and decoration on a page about whether a migration is safe is worse than no number at all — it invites a
 * decision it cannot support. So there is no model, no weighting learned from anywhere, and nothing
 * probabilistic. The score is arithmetic over the findings, the arithmetic is in this file, and clicking a
 * dimension produces the findings that reduced it.
 *
 * ## Why a dimension can refuse to answer
 *
 * `NOT_ASSESSED` exists because the alternative is lying. If nothing in the analysis could say anything
 * about relationships — a single spreadsheet has none to say anything about — then a relationship score of
 * 100 claims a clean bill of health that was never examined. Scoring only what was looked at is the whole
 * difference between a readiness number and a reassurance.
 */

export const READINESS_DIMENSIONS = [
  'IDENTITY',
  'COMPLETENESS',
  'CONSISTENCY',
  'VALIDITY',
  'TYPE_COMPATIBILITY',
  'RELATIONSHIPS',
] as const;
export type ReadinessDimension = (typeof READINESS_DIMENSIONS)[number];

export const READINESS_DIMENSION_LABELS: Record<ReadinessDimension, string> = {
  IDENTITY: 'Identity & keys',
  COMPLETENESS: 'Completeness',
  CONSISTENCY: 'Consistency',
  VALIDITY: 'Validity',
  TYPE_COMPATIBILITY: 'Type compatibility',
  RELATIONSHIPS: 'Relationships',
};

/** What each dimension is actually about, in the words of somebody about to migrate. */
export const READINESS_DIMENSION_DESCRIPTIONS: Record<ReadinessDimension, string> = {
  IDENTITY: 'Whether each record can be reliably identified, so a migration can match rather than duplicate.',
  COMPLETENESS: 'Whether the values that need to be there are there.',
  CONSISTENCY: 'Whether the same thing is written the same way throughout.',
  VALIDITY: 'Whether values are what their column claims they are.',
  TYPE_COMPATIBILITY: 'Whether the stored types mean what a target would assume they mean.',
  RELATIONSHIPS: 'Whether references between tables point at records that exist.',
};

/** Which findings count against which dimension. Duplicates are an identity problem, not a separate axis. */
const DIMENSION_FOR: Record<FindingCategory, ReadinessDimension | null> = {
  IDENTITY: 'IDENTITY',
  DUPLICATES: 'IDENTITY',
  COMPLETENESS: 'COMPLETENESS',
  CONSISTENCY: 'CONSISTENCY',
  VALIDITY: 'VALIDITY',
  TYPE_COMPATIBILITY: 'TYPE_COMPATIBILITY',
  RELATIONSHIPS: 'RELATIONSHIPS',
  SCHEMA: null,
  // A privacy observation is a decision for a person, not a defect in the data. Scoring it would
  // penalise a dataset for containing the customer records it is supposed to contain.
  PRIVACY: null,
};

/**
 * What one finding costs its dimension.
 *
 * Flat per severity, deliberately. A weighting curve tuned until the numbers "looked right" would be the
 * arbitrary score this is meant to replace, wearing arithmetic as a disguise. These three numbers are a
 * stated editorial judgement — a critical finding is most of the way to unusable, an informational one
 * barely moves — and they are in one place where they can be argued with.
 */
const COST: Record<FindingSeverity, number> = { CRITICAL: 35, WARNING: 10, INFO: 2 };

export type ReadinessBand = 'READY' | 'NEEDS_ATTENTION' | 'HIGH_RISK';

export const READINESS_BAND_LABELS: Record<ReadinessBand, string> = {
  READY: 'Ready',
  NEEDS_ATTENTION: 'Needs attention',
  HIGH_RISK: 'High risk',
};

export interface DimensionScore {
  dimension: ReadinessDimension;
  /** Null when nothing in the analysis could speak to this dimension. */
  score: number | null;
  assessed: boolean;
  /** Why it is not assessed, when it is not. */
  notAssessedReason: string | null;
  /** Every finding that reduced this dimension, worst first. */
  findingIds: string[];
  critical: number;
  warning: number;
  info: number;
  /** The arithmetic, in words: "100 − (1 × 35) − (2 × 10) = 45". */
  workings: string;
}

export interface AnalysisReadiness {
  /** Null when no dimension could be assessed at all. */
  score: number | null;
  band: ReadinessBand | null;
  dimensions: DimensionScore[];
  counts: Record<FindingSeverity, number>;
  /** Stated plainly, because a score with no stated method is a number to distrust. */
  method: string;
}

/**
 * Which dimensions the analysis was capable of assessing.
 *
 * Passed in rather than inferred from the findings, because "no findings" and "never looked" produce the
 * same empty list and mean opposite things. A table with a perfect key and a table nobody profiled both
 * yield zero identity findings; only one of them deserves 100.
 */
export interface AssessedDimensions {
  /** Columns were profiled, so keys, nulls, duplicates and value shapes could be judged. */
  profiled: boolean;
  /** Relationship metadata was available. False for a lone spreadsheet, which has none. */
  relationships: boolean;
}

export function assessReadiness(findings: Finding[], assessed: AssessedDimensions): AnalysisReadiness {
  const counts: Record<FindingSeverity, number> = { CRITICAL: 0, WARNING: 0, INFO: 0 };
  for (const f of findings) counts[f.severity] += 1;

  const dimensions = READINESS_DIMENSIONS.map<DimensionScore>((dimension) => {
    // Only the findings that are problems. A discovered business key belongs to IDENTITY and is good news.
    const mine = findings.filter((f) => DIMENSION_FOR[f.category] === dimension && findingDeducts(f));
    const critical = mine.filter((f) => f.severity === 'CRITICAL').length;
    const warning = mine.filter((f) => f.severity === 'WARNING').length;
    const info = mine.filter((f) => f.severity === 'INFO').length;

    const canAssess = dimension === 'RELATIONSHIPS' ? assessed.relationships : assessed.profiled;
    if (!canAssess) {
      return {
        dimension,
        score: null,
        assessed: false,
        notAssessedReason:
          dimension === 'RELATIONSHIPS'
            ? 'No relationship information was available in these datasets, so nothing was examined.'
            : 'No column profiling was available, so nothing was examined.',
        findingIds: [],
        critical: 0,
        warning: 0,
        info: 0,
        workings: 'Not assessed.',
      };
    }

    const deduction = critical * COST.CRITICAL + warning * COST.WARNING + info * COST.INFO;
    const score = Math.max(0, 100 - deduction);
    const parts = [
      critical > 0 ? `${critical} critical × ${COST.CRITICAL}` : null,
      warning > 0 ? `${warning} warning × ${COST.WARNING}` : null,
      info > 0 ? `${info} informational × ${COST.INFO}` : null,
    ].filter(Boolean);
    return {
      dimension,
      score,
      assessed: true,
      notAssessedReason: null,
      findingIds: mine.map((f) => f.id),
      critical,
      warning,
      info,
      workings:
        parts.length === 0
          ? 'Nothing was found against this dimension, so it keeps its full 100.'
          : `100 − ${parts.join(' − ')} = ${score}${deduction > 100 ? ', floored at 0' : ''}`,
    };
  });

  const scored = dimensions.filter((d) => d.score !== null);
  /**
   * The mean of the assessed dimensions, and nothing cleverer.
   *
   * Weighting identity above consistency is defensible and would also be unprovable, so the overall number
   * stays a plain average and the dimensions are shown beside it. A reader who cares more about identity
   * can see identity.
   */
  const score =
    scored.length === 0
      ? null
      : Math.round(scored.reduce((sum, d) => sum + (d.score ?? 0), 0) / scored.length);

  return {
    score,
    band: score === null ? null : bandFor(score, counts.CRITICAL),
    dimensions,
    counts,
    method:
      `Each assessed dimension starts at 100 and loses ${COST.CRITICAL} per critical finding, ${COST.WARNING} per warning and ${COST.INFO} per informational one. ` +
      'The overall figure is the average of the dimensions that could be assessed. Every deduction traces to a finding you can open.',
  };
}

/**
 * The band, which is what a reader actually acts on.
 *
 * A critical finding forces at least NEEDS_ATTENTION however good the average is, because "ready" next to
 * "no record can be reliably identified" is a contradiction a number should not be able to produce. Five
 * criticals is HIGH_RISK whatever else is clean.
 */
export function bandFor(score: number, criticalCount: number): ReadinessBand {
  if (criticalCount >= 3 || score < 50) return 'HIGH_RISK';
  if (criticalCount > 0 || score < 80) return 'NEEDS_ATTENTION';
  return 'READY';
}

// ---------------------------------------------------------------------------
// The executive summary
// ---------------------------------------------------------------------------

export interface ExecutiveSummaryInput {
  projectName: string;
  /** Datasets this assessment actually covers, counted as sheets and tables rather than connections. */
  datasets: number;
  tables: number;
  records: number;
  /**
   * Datasets in the project that this assessment does not cover, in the same unit as `datasets`.
   *
   * Nonzero while a dataset is still being analysed, and after one fails. The paragraph has to say so:
   * the header counts every dataset in the project and this sentence counted only the analysed ones, so
   * a project with a fourth dataset mid-analysis read "4 datasets" at the top and "contains 3 datasets
   * ... 81 out of 100" directly underneath. Both numbers were right and the sentence was still false,
   * because a score presented without its coverage is read as covering everything.
   */
  notAnalysed?: number;
  readiness: AnalysisReadiness;
  findings: Finding[];
}

/** "one dataset" / "4 datasets" — this paragraph gets read aloud, so small numbers are words. */
function count(n: number, noun: string): string {
  return `${n === 1 ? 'one' : n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * A paragraph somebody can read aloud in a meeting.
 *
 * Assembled from the findings rather than generated, so it cannot say anything the evidence does not
 * support. It names the actual top problems instead of recommending that data quality be improved, which
 * is the difference between a summary and a horoscope.
 */
export function executiveSummary(input: ExecutiveSummaryInput): string {
  const { projectName, datasets, tables, records, readiness, findings } = input;
  const notAnalysed = input.notAnalysed ?? 0;
  const held = `${count(tables, 'table')}, totalling ${records.toLocaleString()} ${records === 1 ? 'record' : 'records'}`;
  const scale =
    notAnalysed === 0
      ? `${projectName} contains ${count(datasets, 'dataset')} across ${held}.`
      : `${projectName} contains ${count(datasets + notAnalysed, 'dataset')}, of which ${
          datasets === 1 ? 'one has' : `${datasets} have`
        } been analysed so far: ${held}. The ${
          notAnalysed === 1 ? 'one that has' : `${notAnalysed} that have`
        } not been analysed ${notAnalysed === 1 ? 'is' : 'are'} not counted in anything below.`;

  if (readiness.score === null) {
    return `${projectName} contains ${count(datasets + notAnalysed, 'dataset')}. Nothing has been analysed yet, so there is no assessment to report.`;
  }

  const criticals = findings.filter((f) => f.severity === 'CRITICAL');
  const verdict =
    readiness.band === 'READY'
      ? `The data looks ready to migrate, at ${readiness.score} out of 100, with no critical problems found.`
      : readiness.band === 'NEEDS_ATTENTION'
        ? `The data is partly ready, at ${readiness.score} out of 100.`
        : `The data is not ready to migrate, at ${readiness.score} out of 100.`;

  if (criticals.length === 0) {
    const warnings = findings.filter((f) => f.severity === 'WARNING');
    if (warnings.length === 0) return `${scale} ${verdict}`;
    return `${scale} ${verdict} ${warnings.length === 1 ? 'One issue' : `${warnings.length} issues`} are worth resolving first, beginning with ${titleList(warnings.slice(0, 2))}.`;
  }

  const worst = titleList(criticals.slice(0, 3));
  const affected = criticals.reduce((sum, f) => sum + f.affected, 0);
  const consequence = criticals.some((f) => f.category === 'IDENTITY' || f.category === 'DUPLICATES')
    ? 'Resolving the identity problems first matters most: without a reliable way to match records, a migration cannot tell an update from a new record, so re-running it duplicates data rather than correcting it.'
    : 'Resolving these first will reduce the number of records blocked during the run, and the amount of reconciliation needed afterwards.';

  return (
    `${scale} ${verdict} ${criticals.length === 1 ? 'One critical issue' : `${criticals.length} critical issues`} should be resolved before migrating: ${worst}. ` +
    `${affected > 0 ? `Together these affect about ${affected.toLocaleString()} records. ` : ''}${consequence}`
  );
}

/** "a, b and c" — sentence punctuation, because this paragraph gets read out. */
function titleList(findings: Finding[]): string {
  const titles = findings.map((f) => f.title.replace(/\.$/, ''));
  if (titles.length <= 1) return titles[0] ?? '';
  return `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;
}

/** Grouped for the findings workspace, worst first within each group. */
export function groupByCategory(
  findings: Finding[],
): { category: FindingCategory; label: string; findings: Finding[] }[] {
  const groups = new Map<FindingCategory, Finding[]>();
  for (const f of findings) groups.set(f.category, [...(groups.get(f.category) ?? []), f]);
  const rank: Record<FindingSeverity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  return [...groups.entries()]
    .map(([category, list]) => ({
      category,
      label: FINDING_CATEGORY_LABELS[category],
      findings: [...list].sort((a, b) => rank[a.severity] - rank[b.severity]),
    }))
    .sort((a, b) => rank[a.findings[0]!.severity] - rank[b.findings[0]!.severity]);
}
