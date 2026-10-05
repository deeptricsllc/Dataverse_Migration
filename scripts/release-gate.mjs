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
import { join } from 'node:path';
import { outcomeOf } from './gate-outcome.mjs';

const withEngines = process.argv.includes('--engines');

/**
 * Every check is a real process, started by its path, with its arguments in an array.
 *
 * ## Why there is no shell here any more
 *
 * There used to be `shell: true` on Windows, because `npx` and `npm` are `.cmd` shims and Node refuses to
 * spawn one directly. The cost of that shim was argument safety: with a shell, the command and its
 * arguments are joined into one string and re-parsed, so anything containing a space becomes two things.
 * It caught the content lint the day it was added — `process.execPath` is `C:\Program Files\nodejs\node.exe`
 * on Windows, the shell split it at the space, and the gate reported a failure that was really a gate that
 * never ran.
 *
 * A release gate that can report anything other than what a check actually did is worth less than no gate.
 * So nothing here goes through a shell: every tool is invoked as `node <its own entry point>`, which is
 * what the `.cmd` shims do anyway. Arguments are passed as an array and are never re-parsed, so a
 * repository checked out under "C:\Users\My Name\Documents" works exactly like one that is not.
 */
const node = process.execPath;
const bin = (...parts) => join('node_modules', ...parts);

/** One check. `node` plus a script path, never a shell string. */
const run = (args, env) =>
  spawnSync(node, args, { stdio: 'inherit', env: env ? { ...process.env, ...env } : process.env });

const PRETTIER = bin('prettier', 'bin', 'prettier.cjs');
const ESLINT = bin('eslint', 'bin', 'eslint.js');
const TSC = bin('typescript', 'bin', 'tsc');
const VITEST = bin('vitest', 'vitest.mjs');
const VITE = bin('vite', 'bin', 'vite.js');
const TSUP = bin('tsup', 'dist', 'cli-default.js');
const PLAYWRIGHT = bin('@playwright', 'test', 'cli.js');

/**
 * Two processes, reported as one gate.
 *
 * `typecheck` and `build` are each two commands in package.json. Chaining them through a shell is what
 * this file is getting rid of, so they run in sequence here and the first non-zero result is the gate's.
 */
const both = (first, second) => {
  const a = run(first);
  if (a.error || a.status !== 0) return a;
  return run(second);
};

/** A gate that needs an environment variable produces SKIPPED rather than a false pass. */
const needs = (...vars) => vars.filter((v) => !process.env[v]);

const gates = [
  {
    name: 'format',
    why: 'Prettier is the only formatter; a diff nobody chose is noise in every later review.',
    run: () => run([PRETTIER, '--check', '.']),
  },
  {
    name: 'lint',
    why: 'An unused import is a leftover, and a leftover is a thing somebody will read and trust.',
    run: () => run([ESLINT, '.']),
  },
  {
    name: 'content',
    why: 'Interface text that sounds like an AI describing the product. A guardrail, not a language review.',
    /*
     * No shell for this one. `process.execPath` is an absolute path that contains a space on Windows
     * ("C:\Program Files\nodejs\node.exe"), and a shell splits it at the space and tries to run
     * "C:\Program" — which is the argument-with-a-space trap this file warns about a few lines above.
     * node is a real executable, so it needs no shim and no shell.
     */
    run: () => run(['scripts/content-lint.mjs']),
  },
  {
    name: 'typecheck',
    why: 'Vitest does not typecheck. A suite can be green while the repository does not compile.',
    run: () =>
      both([TSC, '-p', 'tsconfig.server.json', '--noEmit'], [TSC, '-p', 'tsconfig.web.json', '--noEmit']),
  },
  {
    name: 'unit + integration + golden journeys',
    why: 'Including the seven journeys, which run in the ordinary suite so they cannot be forgotten.',
    run: () => run([VITEST, 'run']),
  },
  {
    name: 'build',
    why: 'Before the end-to-end suite, which serves dist/ and does not build it.',
    run: () => both([VITE, 'build', '--config', 'web/vite.config.ts'], [TSUP]),
  },
  {
    name: 'end-to-end',
    why: 'The screens, the mobile widths, and the stale-build guard that refuses yesterday’s bundle.',
    run: () => run([PLAYWRIGHT, 'test']),
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
      run(['scripts/check-evidence-drift.mjs', process.env.DRIFT_COMMITTED, process.env.DRIFT_FRESH]),
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
      run: () => run([VITEST, 'run', '--config', 'vitest.engines.config.ts']),
    },
    {
      name: 'Dataverse tenant harness',
      why: 'Never been executed. Stays SIMULATED until it has.',
      skip: () => (process.env.TENANT_TEST_URL ? null : 'TENANT_TEST_URL is not set'),
      run: () => run([VITEST, 'run', '--config', 'vitest.engines.config.ts']),
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
  const startedAt = new Date();
  console.log('');
  console.log(`=== RUNNING  ${gate.name}  (started ${startedAt.toTimeString().slice(0, 8)})`);
  console.log(`    ${gate.why}`);
  console.log('');
  const started = Date.now();
  const out = gate.run();
  const ms = Date.now() - started;

  /*
   * Whether the check ran at all is decided in `gate-outcome.mjs`, where it is unit tested against real
   * spawn results — including a binary that does not exist, which is the case that silently cost a gate.
   */
  const outcome = outcomeOf(out);
  results.push({
    name: gate.name,
    status: outcome.status,
    code: outcome.code,
    ran: outcome.ran,
    pid: out.pid,
    startedAt: startedAt.toTimeString().slice(0, 8),
    ms,
    seconds: Math.round(ms / 1000),
    detail: outcome.detail,
  });
}

const width = Math.max(...results.map((r) => r.name.length));
console.log('\n' + '='.repeat(width + 34));
console.log('RELEASE GATE');
console.log('='.repeat(width + 34));
for (const r of results) {
  const time = r.seconds === undefined ? '' : `${String(r.seconds).padStart(5)}s`;
  const code = r.code === undefined ? '' : `  exit ${r.code}`;
  console.log(`${r.status.padEnd(11)} ${r.name.padEnd(width)} ${time}${code}`);
  /*
   * What each check actually did, so the table is evidence rather than a claim. A process that started
   * has a pid; one that did not says so where its exit code would have been.
   */
  if (r.ran !== undefined) {
    console.log(
      `            started ${r.startedAt} · ${r.ms} ms · ${r.ran ? `pid ${r.pid} · exited ${r.code}` : 'never started'}`,
    );
  }
  if (r.detail) console.log(`            ${r.detail}`);
}

const failed = results.filter((r) => r.status === 'FAILED' || r.status === 'DID NOT RUN');
const skipped = results.filter((r) => r.status === 'SKIPPED');
console.log('='.repeat(width + 34));
const didNotRun = results.filter((r) => r.status === 'DID NOT RUN');
console.log(
  `${results.filter((r) => r.status === 'PASSED').length} passed, ${failed.length - didNotRun.length} failed, ${didNotRun.length} did not run, ${skipped.length} skipped`,
);
if (didNotRun.length > 0) {
  console.log('A check that did not run proves nothing. It is counted as a failure, not as a pass.');
}
if (skipped.length > 0) {
  console.log(
    'A skipped gate is not a passed one. What it would have proven is still unproven — see docs/HARNESS_CHECKLIST.md.',
  );
}
process.exit(failed.length > 0 ? 1 : 0);
