import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { release } from '../../server/src/connectors/release';
import type { MigrationConnector } from '../../server/src/connectors/types';

/**
 * Every connector that is opened is closed.
 *
 * `connectorFor` returns a new instance on every call and caches nothing, and a SQL connector owns a
 * connection pool. The codebase reached forty-two creations against five disposals: seventeen files
 * opened connections to a customer's database and none of them closed one. Nothing failed, because
 * the pools are `min: 0` with a thirty-second idle timeout and tidy themselves up — which is exactly
 * why it survived so long. The cost only appears under concurrency, against a database whose
 * connection ceiling is low enough to reach, which describes the Azure SQL tier this product is
 * being certified on.
 *
 * A reviewer cannot see this. The creation and the close are usually hundreds of lines apart, and
 * the absence of a close looks like nothing at all. So it is asserted here instead, as a property of
 * the tree rather than a habit: a file that opens a connector is a file that releases one.
 *
 * Deliberately coarse. It counts files, not paths, because tracking which branch closes which
 * connector would need a type checker and would fail on the honest cases -- a connector handed to a
 * caller to close, a run that holds one for its whole length. What it catches is the thing that
 * actually happened: a whole file that never closes anything.
 */

const SERVER = join(import.meta.dirname, '..', '..', 'server', 'src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return entry.endsWith('.ts') ? [path] : [];
  });
}

const OPENS = /\.(?:connectorFor|sqlConnectorFor)\(/g;
const CLOSES = /dispose\?\.\(\)|\.dispose\(\)|await release\(/g;

describe('connectors are released by whatever opens them', () => {
  it('has no file that opens a connector and never closes one', () => {
    const offenders: string[] = [];
    for (const path of tsFiles(SERVER)) {
      const source = readFileSync(path, 'utf8');
      const opens = source.match(OPENS)?.length ?? 0;
      if (opens === 0) continue;
      const closes = source.match(CLOSES)?.length ?? 0;
      if (closes === 0) {
        offenders.push(`${path.slice(SERVER.length + 1)} opens ${opens} and closes none`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  /** The helper's two promises, because a release helper that breaks either one is worse than none. */
  it('closes every connector even when one of them throws', async () => {
    const closed: string[] = [];
    const connector = (name: string, fail = false): MigrationConnector =>
      ({
        dispose: async () => {
          if (fail) throw new Error(`${name} refused to close`);
          closed.push(name);
        },
      }) as unknown as MigrationConnector;

    await expect(
      release(connector('first'), connector('second', true), connector('third')),
    ).resolves.toBeUndefined();
    expect(closed, 'the one that threw did not strand the ones after it').toEqual(['first', 'third']);
  });

  it('tolerates a connector that has nothing to close', async () => {
    // `dispose` is optional on the contract: a connector with no pool implements nothing.
    await expect(release(undefined, null, {} as MigrationConnector)).resolves.toBeUndefined();
  });
});
