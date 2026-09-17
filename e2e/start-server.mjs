// Starts the built server for E2E tests from a clean embedded database.
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.PGLITE_DATA_DIR ?? './.data/e2e');
fs.rmSync(dataDir, { recursive: true, force: true });
if (!fs.existsSync(path.resolve('dist/server/index.js')) || !fs.existsSync(path.resolve('dist/web/index.html'))) {
  console.error('Build output missing. Run `npm run build` before `npm run test:e2e`.');
  process.exit(1);
}
await import(new URL('../dist/server/index.js', import.meta.url).href);
