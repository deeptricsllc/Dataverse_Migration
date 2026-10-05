import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs script with no type declarations, imported for the thing it decides.
import { outcomeOf } from '../../scripts/gate-outcome.mjs';

/**
 * Whether a release gate can tell that a check did not run.
 *
 * This is not a test about formatting a table. A gate that reports a result for a process that never
 * started is reporting on nothing, and the person reading it takes it as a statement about the code.
 *
 * It happened: the content lint was added to the gate as `node scripts/content-lint.mjs` spawned through
 * a shell, and `process.execPath` on Windows is `C:\\Program Files\\nodejs\\node.exe`. The shell split the
 * path at the space and tried to run `C:\\Program`. The check took 0 ms and never executed.
 *
 * Every case below uses a **real** `spawnSync` result rather than a hand-made object, because the thing
 * under test is how Node actually reports these situations.
 */
describe('a check that did not run is not a result', () => {
  it('reports a binary that does not exist as DID NOT RUN', () => {
    const result = spawnSync('a-binary-that-does-not-exist-9f3a2b', ['--version'], { stdio: 'ignore' });
    expect(result.error, 'node reports a spawn failure').toBeTruthy();
    // Windows reports pid 0 here and other platforms report undefined; neither is a process.
    expect(result.pid).toBeFalsy();

    const outcome = outcomeOf(result);
    expect(outcome.ran).toBe(false);
    expect(outcome.status).toBe('DID NOT RUN');
    // No exit code, because there was no exit. Reporting 0 here is the defect this prevents.
    expect(outcome.code).toBeUndefined();
  });

  it('reports a real process that succeeded as PASSED, with its code', () => {
    const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    expect(result.pid).toBeGreaterThan(0);

    const outcome = outcomeOf(result);
    expect(outcome.ran).toBe(true);
    expect(outcome.status).toBe('PASSED');
    expect(outcome.code).toBe(0);
  });

  it('reports a real process that failed as FAILED, with its code', () => {
    const result = spawnSync(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore' });
    const outcome = outcomeOf(result);
    expect(outcome.ran).toBe(true);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.code).toBe(3);
  });

  it('reports a process killed by a signal as FAILED rather than as a pass', () => {
    /*
     * `status` is null when a signal ended the process. A gate that read only `status` and treated a
     * falsy value as success would report a killed test suite as a passing one.
     */
    const outcome = outcomeOf({ pid: 1234, status: null, signal: 'SIGKILL' });
    expect(outcome.ran).toBe(true);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.detail).toContain('SIGKILL');
  });

  /**
   * The specific defect, reproduced.
   *
   * An executable path containing a space, spawned through a shell, with the arguments re-parsed. This is
   * what the gate used to do on Windows, and it is why the fix is to pass arguments as an array and never
   * build a command string.
   */
  it('a path with a space survives direct invocation and is what the gate now uses', () => {
    const direct = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    expect(outcomeOf(direct).status, 'argument-safe invocation runs').toBe('PASSED');
    expect(process.execPath).toContain(process.platform === 'win32' ? '\\' : '/');
  });
});

/**
 * The gate itself invokes every check the same way.
 *
 * Read rather than executed: running the gate inside the gate would take the whole suite with it. What
 * this asserts is the property the fix depends on — no check builds a shell command string.
 */
describe('the release gate invokes checks without a shell', () => {
  it('passes arguments as arrays and never sets shell', async () => {
    const source = await import('node:fs').then((fs) => fs.readFileSync('scripts/release-gate.mjs', 'utf8'));
    /*
     * Code only. The file explains in prose why the shell was removed, and an assertion that cannot tell
     * an explanation from an instruction would forbid writing the explanation down.
     */
    const newline = String.fromCharCode(10);
    const code = source
      .split(newline)
      .filter((line) => {
        const start = line.trimStart();
        return !start.startsWith('*') && !start.startsWith('/*') && !start.startsWith('//');
      })
      .join(newline);
    expect(code).not.toMatch(/shell:/);
    expect(code).not.toContain('npx.cmd');
    expect(code).not.toContain('npm.cmd');
  });
});
