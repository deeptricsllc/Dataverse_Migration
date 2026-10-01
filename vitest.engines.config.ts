import { defineConfig } from 'vitest/config';

/**
 * The real-engine conformance suites.
 *
 * Separate from the main configuration because they need actual database servers and are the only
 * tests allowed to produce ENGINE_VERIFIED evidence. Run serially: three engines writing one
 * evidence file concurrently would race, and the suites provision and drop real schemas.
 */
export default defineConfig({
  test: {
    include: ['tests/engines/**/*.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 180_000,
    pool: 'forks',
    singleFork: true,
    fileParallelism: false,
  },
});
