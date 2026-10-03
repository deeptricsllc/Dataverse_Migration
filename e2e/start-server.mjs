// Starts the built server for E2E tests from a clean embedded database.
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.PGLITE_DATA_DIR ?? './.data/e2e');
fs.rmSync(dataDir, { recursive: true, force: true });
if (
  !fs.existsSync(path.resolve('dist/server/index.js')) ||
  !fs.existsSync(path.resolve('dist/web/index.html'))
) {
  console.error('Build output missing. Run `npm run build` before `npm run test:e2e`.');
  process.exit(1);
}

/**
 * A build older than the code it was built from is worse than no build.
 *
 * `playwright test` serves `dist/`, and it does not build. Run directly, it will happily test
 * yesterday's bundle and report a pass on a fix that is not in it — which is exactly how a landing
 * page 45 pixels too wide passed here and failed in a hosted run. `npm run verify` builds first;
 * anybody reaching for the faster loop gets told rather than misled.
 */
const newest = (dir, skip = () => false) => {
  let latest = 0;
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (skip(full)) continue;
      if (entry.isDirectory()) walk(full);
      else latest = Math.max(latest, fs.statSync(full).mtimeMs);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return latest;
};

const sources = Math.max(newest(path.resolve('web/src')), newest(path.resolve('shared')));
const built = newest(path.resolve('dist/web'));
if (sources > built) {
  const behind = Math.round((sources - built) / 1000);
  console.error(
    `Build is ${behind}s older than web/src or shared/. The tests would run against the previous ` +
      'bundle and could pass without the change under test. Run `npm run build`, or `npm run verify`.',
  );
  process.exit(1);
}
await import(new URL('../dist/server/index.js', import.meta.url).href);
