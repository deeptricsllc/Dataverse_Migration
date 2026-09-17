import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'server/src/index.ts',
    worker: 'server/src/worker.ts',
    'migrate-cli': 'server/src/db/migrate-cli.ts',
  },
  outDir: 'dist/server',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  clean: true,
  splitting: true,
  // Runtime dependencies are resolved from node_modules.
  skipNodeModulesBundle: true,
});
