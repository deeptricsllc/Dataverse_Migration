import type { MigrationConnector } from './types';

/**
 * Closes connectors when the work that opened them is done.
 *
 * `connectorFor` returns a new instance every call and never caches, and a SQL connector owns a
 * connection pool it opens lazily on first query. So a request that builds two connectors, queries
 * through them and returns leaves two pools behind. They are not held forever — the pools are
 * configured `min: 0` with a thirty-second idle timeout, so the sockets come back on their own —
 * but "comes back in thirty seconds" is a different promise from "closed when finished", and the
 * difference is visible precisely where it is least affordable: several people planning at once
 * against an Azure SQL Basic database, whose connection ceiling is low enough to reach.
 *
 * Two rules, both learned from how release helpers usually fail:
 *
 * - **Every connector is attempted**, so one that throws on close does not strand the rest. They are
 *   closed in sequence rather than in parallel, because a pool shutting down is cheap and a stack of
 *   simultaneous teardowns against a struggling server is not.
 * - **Nothing thrown here escapes.** This runs in a `finally`, where throwing would replace whatever
 *   the caller was already failing with — turning a useful integration error into a confusing one
 *   about closing a pool. A connector that cannot be closed is a problem for the pool's own error
 *   handler, not for the person who asked a question about their data.
 */
export async function release(...connectors: (MigrationConnector | null | undefined)[]): Promise<void> {
  for (const connector of connectors) {
    try {
      await connector?.dispose?.();
    } catch {
      // Deliberately swallowed: see above. The pool logs its own errors.
    }
  }
}
