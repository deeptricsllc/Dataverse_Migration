import { and, eq, sql } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { migrationErrors, migrationRuns, validationDifferences, validationRuns } from '../db/schema';
import type { ReadinessAssessment, ReadinessFinding } from '../../../shared/readiness';

/**
 * One problem, followed through every stage that saw it.
 *
 * The chain a buyer asks about:
 *
 *   predicted risk  →  actual outcome  →  validation evidence  →  remediation
 *
 * Each stage already recorded what it saw, and each recorded it in its own vocabulary: readiness names a
 * column and a rule, the engine names a record and an error code, validation names a record and a
 * difference type. Nothing joined them, so a reader had four lists and a hypothesis.
 *
 * What joins them is the **column**, because that is the thing all three stages name. A readiness
 * finding about `account.websiteurl`, migration errors whose `field` is `websiteurl` on table `account`,
 * and validation differences on the same table and field are the same problem seen three times. That is
 * a join on a name rather than on an identifier, and it is stated as such: it is a strong inference, not
 * a recorded relationship, and `confidence` says which.
 *
 * What this deliberately does **not** do is invent a link where the stages have nothing in common. A
 * readiness finding about the plan as a whole (`NO_TABLES_SELECTED`) cannot be joined to a record-level
 * error, and a chain that claimed otherwise would be worse than no chain. Those findings appear with no
 * downstream stages and say so.
 */

export interface ChainStage {
  stage: 'READINESS' | 'MIGRATION' | 'VALIDATION';
  /** What that stage recorded, in its own words. */
  detail: string;
  /** How many records, where the stage counts records. */
  records?: number;
  /** A few identifiers, so somebody can go and look. Never the whole list. */
  examples?: string[];
}

export interface ChainLink {
  /** The table and column the stages agree about, which is what the join is on. */
  table: string | null;
  column: string | null;
  /** The readiness code that predicted it, when one did. */
  predictedBy: string | null;
  severity: ReadinessFinding['severity'] | null;
  stages: ChainStage[];
  /**
   * How the stages were related.
   *
   * `RECORDED` — the stages name the same thing and nothing was inferred (a readiness finding alone).
   * `MATCHED_ON_COLUMN` — joined because they name the same table and column. A strong inference.
   * `UNMATCHED` — a stage saw something no other stage names. Reported rather than dropped.
   */
  confidence: 'RECORDED' | 'MATCHED_ON_COLUMN' | 'UNMATCHED';
}

export interface EvidenceChain {
  runId: string;
  /** False when this run predates the platform recording its assessment. */
  predictionWasRecorded: boolean;
  links: ChainLink[];
  means: string;
}

/** `account.websiteurl` → `{ table: 'account', column: 'websiteurl' }`; a bare table → no column. */
function splitObjectName(name: string | undefined | null): { table: string | null; column: string | null } {
  if (!name) return { table: null, column: null };
  const dot = name.indexOf('.');
  if (dot < 0) return { table: name, column: null };
  return { table: name.slice(0, dot), column: name.slice(dot + 1) };
}

export async function evidenceChain(db: AppDb, runId: string): Promise<EvidenceChain> {
  const [run] = await db
    .select({ readiness: migrationRuns.readinessSnapshot })
    .from(migrationRuns)
    .where(eq(migrationRuns.id, runId));
  const assessment: ReadinessAssessment | null = run?.readiness ?? null;

  // What the engine recorded, grouped by the table and column it names.
  const errors = await db
    .select({
      table: migrationErrors.logicalName,
      field: migrationErrors.field,
      code: migrationErrors.errorCode,
      n: sql<number>`count(*)`,
      examples: sql<string>`string_agg(distinct ${migrationErrors.sourceRecordId}, ',')`,
    })
    .from(migrationErrors)
    .where(and(eq(migrationErrors.runId, runId), eq(migrationErrors.severity, 'ERROR')))
    .groupBy(migrationErrors.logicalName, migrationErrors.field, migrationErrors.errorCode);

  // What validation recorded, from the most recent report for this run.
  const [latest] = await db
    .select({ id: validationRuns.id })
    .from(validationRuns)
    .where(eq(validationRuns.migrationRunId, runId))
    .orderBy(sql`${validationRuns.createdAt} desc`)
    .limit(1);
  const differences = latest
    ? await db
        .select({
          table: validationDifferences.logicalName,
          field: validationDifferences.field,
          type: validationDifferences.differenceType,
          n: sql<number>`count(*)`,
          examples: sql<string>`string_agg(distinct ${validationDifferences.sourceRecordId}, ',')`,
        })
        .from(validationDifferences)
        .where(eq(validationDifferences.validationRunId, latest.id))
        .groupBy(
          validationDifferences.logicalName,
          validationDifferences.field,
          validationDifferences.differenceType,
        )
    : [];

  const sample = (joined: string | null) => (joined ?? '').split(',').filter(Boolean).slice(0, 5);

  const links: ChainLink[] = [];
  const usedErrors = new Set<number>();
  const usedDiffs = new Set<number>();

  // --- start from what was predicted ---------------------------------------
  for (const finding of assessment?.findings ?? []) {
    const { table, column } = splitObjectName(finding.object?.name);
    const stages: ChainStage[] = [
      {
        stage: 'READINESS',
        detail: `${finding.code}: ${finding.evidence}`,
      },
    ];

    /**
     * Joined only when the finding names a column. A finding about a whole table, or about the plan,
     * has nothing specific enough to match a record-level error against, and guessing would attach the
     * wrong records to the wrong prediction.
     */
    if (column) {
      errors.forEach((e, i) => {
        if (e.table !== table || e.field !== column) return;
        usedErrors.add(i);
        stages.push({
          stage: 'MIGRATION',
          detail: `${e.code} on ${e.table}.${e.field}`,
          records: Number(e.n),
          examples: sample(e.examples),
        });
      });
      differences.forEach((d, i) => {
        if (d.table !== table || d.field !== column) return;
        usedDiffs.add(i);
        stages.push({
          stage: 'VALIDATION',
          detail: `${d.type} on ${d.table}.${d.field}`,
          records: Number(d.n),
          examples: sample(d.examples),
        });
      });
    }

    links.push({
      table,
      column,
      predictedBy: finding.code,
      severity: finding.severity,
      stages,
      confidence: stages.length > 1 ? 'MATCHED_ON_COLUMN' : 'RECORDED',
    });
  }

  // --- then whatever no prediction accounts for -----------------------------
  /**
   * A failure nothing predicted is the most interesting row in the table: it is where readiness has a
   * gap. Dropping it because it has no prediction to hang from would hide exactly that.
   */
  errors.forEach((e, i) => {
    if (usedErrors.has(i)) return;
    links.push({
      table: e.table,
      column: e.field,
      predictedBy: null,
      severity: null,
      stages: [
        {
          stage: 'MIGRATION',
          detail: `${e.code}${e.field ? ` on ${e.table}.${e.field}` : ` on ${e.table}`}`,
          records: Number(e.n),
          examples: sample(e.examples),
        },
      ],
      confidence: 'UNMATCHED',
    });
  });
  differences.forEach((d, i) => {
    if (usedDiffs.has(i)) return;
    links.push({
      table: d.table,
      column: d.field,
      predictedBy: null,
      severity: null,
      stages: [
        {
          stage: 'VALIDATION',
          detail: `${d.type}${d.field ? ` on ${d.table}.${d.field}` : ` on ${d.table}`}`,
          records: Number(d.n),
          examples: sample(d.examples),
        },
      ],
      confidence: 'UNMATCHED',
    });
  });

  return {
    runId,
    predictionWasRecorded: assessment !== null,
    links,
    means:
      'Each row follows one problem through the stages that saw it. A row marked MATCHED_ON_COLUMN was ' +
      'joined because the stages name the same table and column: a strong inference, not a recorded ' +
      'relationship. RECORDED means a prediction with nothing downstream, which is what a warning that ' +
      'did not come true looks like. UNMATCHED means a stage saw something no prediction accounts for, ' +
      'which is where the assessment has a gap.',
  };
}
