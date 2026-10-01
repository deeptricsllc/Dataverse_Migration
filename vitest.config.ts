import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The engine suites need real database servers and are opt-in through `npm run test:engines`.
    // Excluded here so an ordinary `npm test` on a checkout without them is a clean pass rather
    // than a wall of skips that nobody reads.
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/engines/**', '**/node_modules/**'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
