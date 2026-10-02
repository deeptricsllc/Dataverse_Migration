import { defineConfig } from 'vitest/config';

/**
 * The real-engine conformance suites.
 *
 * Separate from the main configuration because they need actual database servers or a real Dataverse
 * environment, and are the only tests allowed to produce verification evidence. Run serially: three engines writing one
 * evidence file concurrently would race, and the suites provision and drop real schemas.
 */
export default defineConfig({
  test: {
    // The tenant harness lives alongside the engine suites: same shape, same gating, same reason to be
    // out of the ordinary run — it needs something real to talk to.
    include: ['tests/engines/**/*.test.ts', 'tests/tenant/**/*.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 180_000,
    pool: 'forks',
    singleFork: true,
    fileParallelism: false,
  },
});
