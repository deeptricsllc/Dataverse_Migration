import { and, eq, sql } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { migrationRecordMaps, migrationRunEntities, migrationRuns } from '../db/schema';

/**
 * Rebuilds a run's counters from the identity map.
 *
 * Derived, never incremented, and that is the reason a crash after the identity-map write costs
 * nothing: the next call reconstructs every figure from the rows themselves. Any code that changes a
 * record's outcome — the engine finishing a batch, reconciliation settling a record a person looked at —
 * calls this afterwards rather than adjusting a number, so there is one definition of what the counters
 * mean and no path that can drift from it.
 */
export async function refreshRunCounters(db: AppDb, runId: string, runEntityId?: string): Promise<void> {
  const entityRows = await db
    .select()
    .from(migrationRunEntities)
    .where(eq(migrationRunEntities.runId, runId));
  const grouped = await db
    .select({
      logicalName: migrationRecordMaps.logicalName,
      outcome: migrationRecordMaps.outcome,
      n: sql<number>`count(*)`,
    })
    .from(migrationRecordMaps)
    .where(eq(migrationRecordMaps.runId, runId))
    .groupBy(migrationRecordMaps.logicalName, migrationRecordMaps.outcome);

  const totals = {
    total: 0,
    processed: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    unresolved: 0,
  };
  for (const e of entityRows) {
    const get = (o: string) =>
      Number(grouped.find((g) => g.logicalName === e.logicalName && g.outcome === o)?.n ?? 0);
    const c = {
      created: get('CREATED'),
      updated: get('UPDATED'),
      unchanged: get('UNCHANGED'),
      skipped: get('SKIPPED'),
      failed: get('FAILED'),
      unresolved: get('UNRESOLVED'),
    };
    // Unresolved records were processed: something was attempted and the answer was lost. Leaving them
    // out of `processed` to keep the other five adding up would be hiding them.
    const processed = c.created + c.updated + c.unchanged + c.skipped + c.failed + c.unresolved;
    if (!runEntityId || runEntityId === e.id) {
      await db
        .update(migrationRunEntities)
        .set({ ...c, processed })
        .where(eq(migrationRunEntities.id, e.id));
    }
    totals.total += Math.max(e.total, processed);
    totals.processed += processed;
    totals.created += c.created;
    totals.updated += c.updated;
    totals.unchanged += c.unchanged;
    totals.skipped += c.skipped;
    totals.failed += c.failed;
    totals.unresolved += c.unresolved;
  }
  await db
    .update(migrationRuns)
    .set({ ...totals, updatedAt: new Date() })
    .where(eq(migrationRuns.id, runId));
}

/** Deferred-pass counters, rebuilt the same way and for the same reason. */
export async function refreshDeferredCounters(db: AppDb, runId: string, logicalName: string): Promise<void> {
  const rows = await db
    .select({ status: migrationRecordMaps.deferredStatus, n: sql<number>`count(*)` })
    .from(migrationRecordMaps)
    .where(and(eq(migrationRecordMaps.runId, runId), eq(migrationRecordMaps.logicalName, logicalName)))
    .groupBy(migrationRecordMaps.deferredStatus);
  const get = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  await db
    .update(migrationRunEntities)
    .set({
      deferredPending: get('PENDING'),
      deferredResolved: get('RESOLVED'),
      deferredFailed: get('FAILED'),
    })
    .where(and(eq(migrationRunEntities.runId, runId), eq(migrationRunEntities.logicalName, logicalName)));
}
