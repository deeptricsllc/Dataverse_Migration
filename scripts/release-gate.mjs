#!/usr/bin/env node
/**
 * The golden release gate.
 *
 * Every suite, run in sequence, with each exit code captured **independently**. That is the whole point:
 * a shell pipeline reports the status of its last command, so `a && b | tee log` has hidden a failing `a`
 * in this project before. Nothing here pipes, nothing here uses `&&`, and the summary at the end is built
 * from the codes rather than from whether anything printed the word "fail".
 *
 * Order matters in one place: the build runs before the end-to-end suite, because `playwright test` serves
 * `dist/` and does not build it. Running them the other way round tests yesterday's bundle, which is
 * exactly how a landing page forty-five pixels too wide once passed here and failed in CI.
 *
 *   node scripts/release-gate.mjs            every gate that needs nothing external
 *   node scripts/release-gate.mjs --engines   also the real-engine suites, if their URLs are set
 *
 * Exits non-zero if any gate failed. Prints a table either way, because a gate that only speaks when it is
 * unhappy teaches people to run it and look away.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const withEngines = process.argv.includes('--engines');
const onWindows = process.platform === 'win32';
const npx = onWindows ? 'npx.cmd' : 'npx';
const npm = onWindows ? 'npm.cmd' : 'npm';
/**
 * `shell` is required on Windows and must stay off everywhere else.
 *
 * npx and npm are `.cmd` shims there, and Node refuses to spawn one directly — it returns EINVAL, which
 * this script dutifully reported as seven failed gates the first time it ran. Using a shell unconditionally
 * would mean every argument is parsed by one, which is how an argument with a space becomes two.
 */
const spawnOpts = { stdio: 'inherit', shell: onWindows };

/** A gate that needs an environment variable produces SKIPPED rather than a false pass. */
const needs = (...vars) => vars.filter((v) => !process.env[v]);

const gates = [
  {
    name: 'format',
    why: 'Prettier is the only formatter; a diff nobody chose is noise in every later review.',
    run: () => spawnSync(npx, ['prettier', '--check', '.'], spawnOpts),
  },
  {
    name: 'lint',
    why: 'An unused import is a leftover, and a leftover is a thing somebody will read and trust.',
    run: () => spawnSync(npx, ['eslint', '.'], spawnOpts),
  },
  {
    name: 'typecheck',
    why: 'Vitest does not typecheck. A suite can be green while the repository does not compile.',
    run: () => spawnSync(npm, ['run', 'typecheck'], spawnOpts),
  },
  {
    name: 'unit + integration + golden journeys',
    why: 'Including the seven journeys, which run in the ordinary suite so they cannot be forgotten.',
    run: () => spawnSync(npx, ['vitest', 'run'], spawnOpts),
  },
  {
    name: 'build',
    why: 'Before the end-to-end suite, which serves dist/ and does not build it.',
    run: () => spawnSync(npm, ['run', 'build'], spawnOpts),
  },
  {
    name: 'end-to-end',
    why: 'The screens, the mobile widths, and the stale-build guard that refuses yesterday’s bundle.',
    run: () => spawnSync(npx, ['playwright', 'test'], spawnOpts),
  },
  {
    name: 'evidence drift',
    why: 'Refuses a verification claim the evidence files do not back, in either direction.',
    /**
     * It compares a **committed** snapshot against a **fresh** engine run, so it needs both files and only
     * means anything after the engines have run. CI does exactly that, after the conformance suites. Here
     * it skips unless somebody points it at two files, rather than running it with none and failing.
     */
    skip: () => {
      if (!existsSync('scripts/check-evidence-drift.mjs')) return 'the drift check is not present';
      const committed = process.env.DRIFT_COMMITTED;
      const fresh = process.env.DRIFT_FRESH;
      if (!committed || !fresh) {
        return 'it compares a committed snapshot against a fresh engine run; CI does this after the engine suites';
      }
      return null;
    },
    run: () =>
      spawnSync(
        process.execPath,
        ['scripts/check-evidence-drift.mjs', process.env.DRIFT_COMMITTED, process.env.DRIFT_FRESH],
        { stdio: 'inherit' },
      ),
  },
];

if (withEngines) {
  gates.push(
    {
      name: 'real engines (postgres, mysql, sql server)',
      why: 'The conformance suites against real servers. Skipped when no URL is set, never faked.',
      skip: () => {
        const missing = needs('TEST_POSTGRES_URL', 'TEST_MYSQL_URL', 'TEST_MSSQL_URL');
        return missing.length === 3 ? `none of ${missing.join(', ')} is set` : null;
      },
      run: () => spawnSync(npm, ['run', 'test:engines'], spawnOpts),
    },
    {
      name: 'Dataverse tenant harness',
      why: 'Never been executed. Stays SIMULATED until it has.',
      skip: () => (process.env.TENANT_TEST_URL ? null : 'TENANT_TEST_URL is not set'),
      run: () => spawnSync(npm, ['run', 'test:engines'], spawnOpts),
    },
  );
}

const results = [];
for (const gate of gates) {
  const skipped = gate.skip?.();
  if (skipped) {
    results.push({ name: gate.name, status: 'SKIPPED', detail: skipped });
    console.log(`\n=== SKIPPED  ${gate.name} — ${skipped}\n`);
    continue;
  }
  console.log(`\n=== RUNNING  ${gate.name}\n    ${gate.why}\n`);
  const started = Date.now();
  const out = gate.run();
  /**
   * `status` is null when the process was killed by a signal, and `error` is set when it never started.
   * Both are failures, and neither has a usable exit code — a gate that read only `status` would report a
   * killed suite as a pass.
   */
  const code = out.error ? -1 : (out.status ?? -1);
  results.push({
    name: gate.name,
    status: code === 0 ? 'PASSED' : 'FAILED',
    code,
    seconds: Math.round((Date.now() - started) / 1000),
    detail: out.error ? out.error.message : undefined,
  });
}

const width = Math.max(...results.map((r) => r.name.length));
console.log('\n' + '='.repeat(width + 34));
console.log('RELEASE GATE');
console.log('='.repeat(width + 34));
for (const r of results) {
  const time = r.seconds === undefined ? '' : `${String(r.seconds).padStart(5)}s`;
  const code = r.code === undefined ? '' : `  exit ${r.code}`;
  console.log(`${r.status.padEnd(8)} ${r.name.padEnd(width)} ${time}${code}`);
  if (r.detail) console.log(`         ${r.detail}`);
}

const failed = results.filter((r) => r.status === 'FAILED');
const skipped = results.filter((r) => r.status === 'SKIPPED');
console.log('='.repeat(width + 34));
console.log(
  `${results.filter((r) => r.status === 'PASSED').length} passed, ${failed.length} failed, ${skipped.length} skipped`,
);
if (skipped.length > 0) {
  console.log(
    'A skipped gate is not a passed one. What it would have proven is still unproven — see docs/HARNESS_CHECKLIST.md.',
  );
}
process.exit(failed.length > 0 ? 1 : 0);
