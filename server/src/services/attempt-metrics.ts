import { and, asc, countDistinct, eq, isNotNull, sql } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { migrationErrors, migrationRecordMaps } from '../db/schema';
import type { RunAttemptSummary } from '../../../shared/domain';

/**
 * What each attempt of a run is answerable for.
 *
 * Two kinds of number, and conflating them is how a migration lead ends up reading a total that cannot
 * be reconciled with anything:
 *
 *   **Run metrics are final accountability.** How many source records exist, and what became of each
 *   one. One figure per outcome, derived from the identity map, where every record is counted exactly
 *   once. This is what somebody signs for.
 *
 *   **Attempt metrics are execution history.** Which attempt is responsible for the state each record
 *   is now in. Useful for the question "the first run failed — what did the second one actually do".
 *
 * The decomposition is by **final responsibility**, not by activity, and that choice is what makes it
 * safe. Each identity row records the attempt that last touched it, so every record belongs to exactly
 * one attempt and the attempts sum to the run total without counting anything twice. Summing activity
 * instead — "attempt 1 wrote 400, attempt 2 wrote 600" for a run of 700 records — produces a number
 * larger than the data, which is the trap the brief names.
 *
 * The cost of that choice, stated because it is a real limit: **work an earlier attempt did on a record
 * a later attempt touched again is no longer separately visible.** A record created in attempt 1 and
 * updated in attempt 2 appears under attempt 2 only. The run total stays right; attempt 1's history of
 * that one record does not survive. Recording it would mean a row per record per attempt, which is a
 * different and much larger thing than a column.
 *
 * Which had a worse consequence than the limit itself: an attempt every one of whose records was re-done by
 * the next attempt had no row at all. A run at attempt 2 showed a history containing only attempt 2, as
 * though the first had never happened — and the first attempt is what somebody auditing the migration is
 * looking for. So `recordsWithProblems` is read from the error rows, which are inserted per attempt and
 * never replaced, and an attempt that recorded anything appears whatever a later attempt did afterwards.
 */
export async function attemptMetrics(db: AppDb, runId: string): Promise<RunAttemptSummary[]> {
  const grouped = await db
    .select({
      attempt: migrationRecordMaps.runAttempt,
      outcome: migrationRecordMaps.outcome,
      n: sql<number>`count(*)`,
      firstAt: sql<string>`min(${migrationRecordMaps.updatedAt})`,
      lastAt: sql<string>`max(${migrationRecordMaps.updatedAt})`,
    })
    .from(migrationRecordMaps)
    .where(eq(migrationRecordMaps.runId, runId))
    .groupBy(migrationRecordMaps.runAttempt, migrationRecordMaps.outcome)
    .orderBy(asc(migrationRecordMaps.runAttempt));

  /*
   * Failures and warnings per attempt, counted per record, from rows that are never overwritten. This is
   * what keeps an earlier attempt in the history after a later one has re-done its records.
   */
  const problems = await db
    .select({
      attempt: migrationErrors.runAttempt,
      records: countDistinct(migrationErrors.sourceRecordId),
    })
    .from(migrationErrors)
    .where(eq(migrationErrors.runId, runId))
    .groupBy(migrationErrors.runAttempt);

  const byAttempt = new Map<number | null, RunAttemptSummary>();
  const blank = (key: number | null, firstAt: string, lastAt: string): RunAttemptSummary => ({
    attempt: key,
    recordsWithProblems: null,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    unresolved: 0,
    firstRecordAt: firstAt,
    lastRecordAt: lastAt,
  });
  for (const row of grouped) {
    const key = row.attempt ?? null;
    let summary = byAttempt.get(key);
    if (!summary) {
      summary = blank(key, row.firstAt, row.lastAt);
      byAttempt.set(key, summary);
    }
    const n = Number(row.n);
    switch (row.outcome) {
      case 'CREATED':
        summary.created += n;
        break;
      case 'UPDATED':
        summary.updated += n;
        break;
      case 'UNCHANGED':
        summary.unchanged += n;
        break;
      case 'SKIPPED':
        summary.skipped += n;
        break;
      case 'FAILED':
        summary.failed += n;
        break;
      case 'UNRESOLVED':
        summary.unresolved += n;
        break;
    }
    if (row.firstAt < summary.firstRecordAt) summary.firstRecordAt = row.firstAt;
    if (row.lastAt > summary.lastRecordAt) summary.lastRecordAt = row.lastAt;
  }

  /*
   * And the attempts that recorded problems, including any whose records a later attempt has since taken
   * over. Without this an attempt that failed every record and was then entirely re-done would not appear.
   */
  for (const row of problems) {
    const key = row.attempt ?? null;
    let summary = byAttempt.get(key);
    if (!summary) {
      // No outcome rows left under this attempt: every record it touched belongs to a later one now.
      summary = blank(key, '', '');
      byAttempt.set(key, summary);
    }
    summary.recordsWithProblems = Number(row.records);
  }

  // Null last: rows from before the attempt was recorded are "not known", not attempt zero.
  return [...byAttempt.values()].sort((a, b) => {
    if (a.attempt === null) return 1;
    if (b.attempt === null) return -1;
    return a.attempt - b.attempt;
  });
}

/** Whether any record predates the attempt being recorded, which a report has to say rather than hide. */
export async function hasUnattributedRecords(db: AppDb, runId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(migrationRecordMaps)
    .where(sql`${migrationRecordMaps.runId} = ${runId} and ${migrationRecordMaps.runAttempt} is null`);
  return Number(row?.n ?? 0) > 0;
}

/** Records whose attempt is known. Used to assert that the decomposition adds up. */
export async function attributedRecordCount(db: AppDb, runId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(migrationRecordMaps)
    .where(and(eq(migrationRecordMaps.runId, runId), isNotNull(migrationRecordMaps.runAttempt)));
  return Number(row?.n ?? 0);
}
